import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Contract } from "ethers";
import { createFlightEvent } from "../../test/helpers/deploy";
import {
  SALT,
  Stack,
  SignedReport,
  bindPolicy,
  commitHash,
  signReport,
} from "../../test/helpers/engine";
import { PolicyDraw, World, ORACLE_SOURCES, shouldPay } from "./world";

const FORGE_MILLI = 90_000n; // what a forged report moves the value by (minutes x 1000)

export interface PolicyOutcome {
  bucket: number;
  decision: "pay" | "nopay" | "held";
  correct: boolean | null;
}

export interface EventMetrics {
  oracleTxs: number;
  oracleGas: number;
  settleGas: number;
  rounds: number;
  /** Decided by evidence before any default. */
  auto: number;
  /** Decided by the default rule after the challenge period. */
  byDefault: number;
  /** Still undecided at the end (held, or disputed awaiting the admin). */
  held: number;
  wrong: number;
  wrongAuto: number;
  total: number;
  finalStatus: string;
  firstRoundInsufficient: boolean;
}

const gasOf = async (p: Promise<{ wait(): Promise<{ gasUsed: bigint } | null> }>) =>
  Number((await (await p).wait())?.gasUsed ?? 0n);

/** Gas of the last mined transaction (a reverted one is mined but ethers throws). */
async function lastTxGas(): Promise<number> {
  const block = await ethers.provider.getBlock("latest", true);
  const hash = block?.transactions[0];
  if (!hash) return 0;
  const rc = await ethers.provider.getTransactionReceipt(String(hash));
  return Number(rc?.gasUsed ?? 0n);
}

async function decisions(stack: Stack, eventId: number, policies: PolicyDraw[], truth: number) {
  const pay = Number(await stack.engine.payCursor(eventId));
  const noPay = Number(await stack.engine.noPayCursor(eventId));
  return policies.map((p): PolicyOutcome => {
    const decision = p.bucket <= pay ? "pay" : p.bucket >= noPay ? "nopay" : "held";
    return {
      bucket: p.bucket,
      decision,
      correct: decision === "held" ? null : (decision === "pay") === shouldPay(truth, p.bucket),
    };
  });
}

/** Plays one event through TIES end to end, with the oracle nodes' behaviour from `world`. */
export async function playTies(
  stack: Stack,
  world: World,
  policies: PolicyDraw[],
  holders: Contract["runner"][],
): Promise<EventMetrics> {
  const { engine, book, oracles, sourceWallets } = stack;
  const eventId = Number(await createFlightEvent(book, 1000, 2000));
  for (let i = 0; i < policies.length; i++) {
    const holder = holders[i % holders.length] as Parameters<typeof bindPolicy>[1];
    await bindPolicy(
      stack,
      holder,
      eventId,
      policies[i].bucket,
      ethers.parseEther(policies[i].payoutEth),
    );
  }
  const meta = await book.eventMeta(eventId);
  await time.increaseTo(Number(meta.observationEnd));
  await engine.openRound(eventId);

  const m: EventMetrics = {
    oracleTxs: 0,
    oracleGas: 0,
    settleGas: 0,
    rounds: 0,
    auto: 0,
    byDefault: 0,
    held: 0,
    wrong: 0,
    wrongAuto: 0,
    total: policies.length,
    finalStatus: "",
    firstRoundInsufficient: false,
  };
  for (let guard = 0; guard < 8; guard++) {
    const st = await engine.eventState(eventId);
    const status = Number(st.status);
    if (status !== 1 && status !== 2) break;
    const round = Number(st.round);
    const committee: string[] = await engine.committeeOf(eventId, round);
    const reveals: { r: SignedReport; i: number; tamper: boolean }[] = [];
    for (const member of committee) {
      const i = oracles.findIndex((o) => o.address === member);
      const reading = world.read(ORACLE_SOURCES[i]);
      const mode = world.nodeMode(i);
      if (reading === null) continue; // source down: the node cannot fetch, so it never commits
      const value = BigInt(Math.round(reading * 1000));
      const signed = await signReport(stack, sourceWallets[ORACLE_SOURCES[i] - 1], eventId, value);
      const tamper = mode === "tamper";
      const committed = tamper ? { ...signed, value: value + FORGE_MILLI } : signed;
      m.oracleGas += await gasOf(
        engine
          .connect(oracles[i])
          .commit(eventId, round, commitHash(committed, SALT, oracles[i].address)),
      );
      m.oracleTxs += 1;
      if (mode === "honest" || tamper) reveals.push({ r: committed, i, tamper });
    }
    await time.increaseTo(Number(st.commitDeadline));
    for (const { r, i, tamper } of reveals) {
      m.oracleTxs += 1;
      try {
        m.oracleGas += await gasOf(
          engine
            .connect(oracles[i])
            .reveal(
              eventId,
              round,
              r.value,
              r.ts,
              r.toolHash,
              r.argsHash,
              r.responseHash,
              r.sourceSig,
              SALT,
              { gasLimit: 900_000 },
            ),
        );
      } catch {
        if (!tamper) throw new Error("honest reveal reverted");
        m.oracleGas += await lastTxGas();
      }
    }
    await time.increaseTo(Number(st.revealDeadline));
    const rc = await (await engine.finalizeRound(eventId)).wait();
    m.settleGas += Number(rc?.gasUsed ?? 0n);
    m.rounds = round;
    if (round === 1) {
      const logs = (rc?.logs ?? []).map((l) => {
        try {
          return engine.interface.parseLog({ topics: [...l.topics], data: l.data });
        } catch {
          return null;
        }
      });
      const rf = logs.find((l) => l?.name === "RoundFinalized");
      m.firstRoundInsufficient = rf != null && Number(rf.args.status) === 0;
    }
  }

  let st = await engine.eventState(eventId);
  const before = await decisions(stack, eventId, policies, world.truth);
  m.auto = before.filter((o) => o.decision !== "held").length;
  m.wrongAuto = before.filter((o) => o.correct === false).length;
  if (Number(st.status) === 3) {
    await time.increaseTo(Number(st.challengeDeadline));
    const gas = await gasOf(engine.applyDefault(eventId));
    m.settleGas += gas;
    st = await engine.eventState(eventId);
  }
  const after = await decisions(stack, eventId, policies, world.truth);
  m.byDefault = after.filter((o) => o.decision !== "held").length - m.auto;
  m.held = after.filter((o) => o.decision === "held").length;
  m.wrong = after.filter((o) => o.correct === false).length;
  m.finalStatus = ["NONE", "ROUND_COMMIT", "ROUND_REVEAL", "DEFAULT_PENDING", "DISPUTED", "FINAL"][
    Number(st.status)
  ];
  return m;
}

export type BaselineName = "single" | "avg2" | "median3" | "median7";
export const BASELINE_CONTRACTS: Record<BaselineName, string> = {
  single: "BaselineSingle",
  avg2: "BaselineAvg2",
  median3: "BaselineMedian3",
  median7: "BaselineMedian7",
};
/** Which of the scenario's oracle keys each baseline asks, in committee order. */
export const BASELINE_KEYS: Record<BaselineName, number> = {
  single: 1,
  avg2: 2,
  median3: 3,
  median7: 7,
};

export interface BaselineMetrics {
  oracleTxs: number;
  oracleGas: number;
  settleGas: number;
  settled: boolean;
  wrong: number;
  total: number;
  /** settleAll could not run within the block gas limit. */
  exceedsBlockLimit: boolean;
}

/** Plays one event through a baseline fed the same readings. */
export async function playBaseline(
  c: Contract,
  stack: Stack,
  eventId: number,
  name: BaselineName,
  committeeOracles: number[],
  world: World,
  policies: PolicyDraw[],
  holders: Contract["runner"][],
): Promise<BaselineMetrics> {
  const now = await time.latest();
  await c.createEvent(eventId, now + 100_000);
  for (let i = 0; i < policies.length; i++) {
    const holder = holders[i % holders.length] as Parameters<typeof bindPolicy>[1];
    const payout = ethers.parseEther(policies[i].payoutEth);
    await c.connect(holder).bind(eventId, policies[i].bucket, payout, { value: payout / 20n });
  }
  const keys =
    name === "median7" ? [0, 1, 2, 3, 4, 5, 6] : committeeOracles.slice(0, BASELINE_KEYS[name]);
  const m: BaselineMetrics = {
    oracleTxs: 0,
    oracleGas: 0,
    settleGas: 0,
    settled: false,
    wrong: 0,
    total: policies.length,
    exceedsBlockLimit: false,
  };
  for (const i of keys) {
    const reading = world.read(ORACLE_SOURCES[i]);
    const mode = world.nodeMode(i);
    if (reading === null || mode === "silent" || mode === "late") continue;
    const value = BigInt(Math.round(reading * 1000)) + (mode === "tamper" ? FORGE_MILLI : 0n);
    m.oracleGas += await gasOf(c.connect(stack.oracles[i]).report(eventId, value));
    m.oracleTxs += 1;
  }
  try {
    const rc = await (await c.settleAll(eventId)).wait();
    m.settleGas = Number(rc?.gasUsed ?? 0n);
    m.settled = true;
    const log = rc?.logs
      .map((l) => {
        try {
          return c.interface.parseLog({ topics: [...l.topics], data: l.data });
        } catch {
          return null;
        }
      })
      .find((l) => l?.name === "Settled");
    const value = Number(log?.args.value ?? 0n);
    m.wrong = policies.filter(
      (p) => value >= p.bucket * 1000 !== shouldPay(world.truth, p.bucket),
    ).length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/NotReady/.test(msg)) m.settled = false;
    else if (/gas/i.test(msg)) m.exceedsBlockLimit = true;
    else throw err;
  }
  return m;
}
