/**
 * Experiment runner. Plays every flight scenario against TIES and the four baseline contracts on
 * the in-process Hardhat network, with real transactions and receipts.
 *
 *   npx hardhat run experiments/run.ts
 *
 * Environment: EXP_EVENTS (default 100), EXP_POLICIES (default 20), EXP_SWEEP_EVENTS (default 30),
 * EXP_SEED (default 1), EXP_QUICK=1 (tiny run for checking the pipeline).
 */
import { ethers, network } from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { FLIGHT_DELAY_PARAMS } from "../packages/ties-math/src";
import {
  deployEngine,
  Stack,
  bindPolicy,
  signReport,
  SALT,
  commitHash,
} from "../test/helpers/engine";
import { createFlightEvent } from "../test/helpers/deploy";
import { SCENARIOS, ScenarioDef } from "./scenarios";
import {
  BASELINE_CONTRACTS,
  BaselineMetrics,
  BaselineName,
  EventMetrics,
  playBaseline,
  playTies,
} from "./lib/drivers";
import {
  ORACLE_SOURCES,
  drawPolicies,
  makeWorld,
  mulberry32,
  nodeId,
  zForRound,
} from "./lib/world";

const QUICK = process.env.EXP_QUICK === "1";
const N_EVENTS = Number(process.env.EXP_EVENTS ?? (QUICK ? 3 : 100));
const N_POLICIES = Number(process.env.EXP_POLICIES ?? (QUICK ? 6 : 20));
const SWEEP_EVENTS = Number(process.env.EXP_SWEEP_EVENTS ?? (QUICK ? 3 : 30));
const SEED = Number(process.env.EXP_SEED ?? 1);
const PAYOUT = "0.4";
const BASELINES: BaselineName[] = ["single", "avg2", "median3", "median7"];
const EXPERIMENT_SCENARIOS = SCENARIOS.filter(
  (s) => s.category === "FLIGHT" && s.name !== "challenged-default",
);

const root = path.join(__dirname);
const resultsDir = path.join(root, "results");
const rawDir = path.join(resultsDir, "raw");

const log = (msg: string) => console.log(`[experiments] ${msg}`);

async function freshStack(committee: string[], overrides: Parameters<typeof deployEngine>[0] = {}) {
  const specs = ORACLE_SOURCES.map((source, i) => ({
    source,
    primary: committee.includes(nodeId(i)),
  }));
  const stack = await deployEngine(overrides, { oracles: specs, engineName: "SettlementEngine" });
  await setBalance(stack.lp1.address, 10n ** 23n);
  await stack.vault.connect(stack.lp1).deposit({ value: ethers.parseEther("9000") });
  return stack;
}

async function freshBaselines(stack: Stack) {
  const funders = await ethers.getSigners();
  const out = {} as Record<BaselineName, Awaited<ReturnType<typeof deployBaseline>>>;
  for (const [i, name] of BASELINES.entries()) {
    out[name] = await deployBaseline(stack, name, funders[i + 14]);
  }
  return out;
}

async function deployBaseline(
  stack: Stack,
  name: BaselineName,
  funder: Awaited<ReturnType<typeof ethers.getSigners>>[number],
) {
  await setBalance(funder.address, 10n ** 23n);
  const c = await (
    await ethers.getContractFactory(BASELINE_CONTRACTS[name])
  ).deploy(stack.admin.address);
  await c.connect(funder).fund({ value: ethers.parseEther("9000") });
  for (let i = 0; i < stack.oracles.length; i++)
    await c.setOracle(stack.oracles[i].address, ORACLE_SOURCES[i]);
  return c;
}

async function holdersOf(stack: Stack) {
  const all = await ethers.getSigners();
  return [stack.alice, stack.bob, ...all.slice(13, 14)].filter(Boolean);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

interface TiesAgg {
  events: number;
  policies: number;
  wrongRate: number;
  /** Wrong decisions among the policies settled by evidence alone, before any default. */
  wrongAmongAuto: number;
  /** Wrong decisions among the policies settled by the default rule. */
  wrongAmongDefault: number;
  autoRate: number;
  defaultRate: number;
  heldRate: number;
  oracleTxsPerEvent: number;
  oracleGasPerEvent: number;
  settleGasPerEvent: number;
  gasPerPolicy: number;
  bindGasPerPolicy: number;
  roundsPerEvent: number;
  firstRoundInsufficientRate: number;
  statuses: Record<string, number>;
}
interface BaselineAgg {
  wrongRate: number;
  settledRate: number;
  oracleTxsPerEvent: number;
  oracleGasPerEvent: number;
  settleGasPerEvent: number;
  gasPerPolicy: number;
  bindGasPerPolicy: number;
  exceedsBlockLimit: number;
}

function aggTies(ms: EventMetrics[]): TiesAgg {
  const policies = sum(ms.map((m) => m.total));
  const statuses: Record<string, number> = {};
  for (const m of ms) statuses[m.finalStatus] = (statuses[m.finalStatus] ?? 0) + 1;
  return {
    events: ms.length,
    policies,
    wrongRate: sum(ms.map((m) => m.wrong)) / policies,
    wrongAmongAuto: sum(ms.map((m) => m.wrongAuto)) / Math.max(1, sum(ms.map((m) => m.auto))),
    wrongAmongDefault:
      sum(ms.map((m) => m.wrong - m.wrongAuto)) / Math.max(1, sum(ms.map((m) => m.byDefault))),
    autoRate: sum(ms.map((m) => m.auto)) / policies,
    defaultRate: sum(ms.map((m) => m.byDefault)) / policies,
    heldRate: sum(ms.map((m) => m.held)) / policies,
    oracleTxsPerEvent: mean(ms.map((m) => m.oracleTxs)),
    oracleGasPerEvent: mean(ms.map((m) => m.oracleGas)),
    settleGasPerEvent: mean(ms.map((m) => m.settleGas)),
    gasPerPolicy: sum(ms.map((m) => m.settleGas)) / policies,
    bindGasPerPolicy: sum(ms.map((m) => m.bindGas)) / policies,
    roundsPerEvent: mean(ms.map((m) => m.rounds)),
    firstRoundInsufficientRate: mean(ms.map((m) => (m.firstRoundInsufficient ? 1 : 0))),
    statuses,
  };
}

function aggBaseline(ms: BaselineMetrics[]): BaselineAgg {
  const policies = sum(ms.map((m) => m.total));
  const settled = ms.filter((m) => m.settled);
  return {
    // Wrong settlements as a share of all policies; an unsettled event contributes none (it is held).
    wrongRate: sum(ms.map((m) => m.wrong)) / policies,
    settledRate: sum(ms.map((m) => (m.settled ? m.total : 0))) / policies,
    oracleTxsPerEvent: mean(ms.map((m) => m.oracleTxs)),
    oracleGasPerEvent: mean(ms.map((m) => m.oracleGas)),
    settleGasPerEvent: mean(settled.map((m) => m.settleGas)),
    gasPerPolicy:
      sum(settled.map((m) => m.settleGas)) / Math.max(1, sum(settled.map((m) => m.total))),
    bindGasPerPolicy: sum(ms.map((m) => m.bindGas)) / policies,
    exceedsBlockLimit: sum(ms.map((m) => (m.exceedsBlockLimit ? 1 : 0))),
  };
}

interface ScenarioResult {
  ties: TiesAgg;
  baselines: Record<BaselineName, BaselineAgg>;
}

async function runScenario(
  sc: Pick<ScenarioDef, "name" | "committee" | "sources" | "nodes">,
  nEvents: number,
  opts: {
    overrides?: Parameters<typeof deployEngine>[0];
    spread?: number;
    seedOffset?: number;
  } = {},
): Promise<ScenarioResult> {
  const stack = await freshStack(sc.committee, opts.overrides);
  const baselines = await freshBaselines(stack);
  const holders = await holdersOf(stack);
  const rng = mulberry32(SEED * 1000 + (opts.seedOffset ?? 0));
  const committeeOracles = sc.committee.map((id) => Number(id.slice(1)) - 1);
  const tiesMs: EventMetrics[] = [];
  const baseMs = Object.fromEntries(BASELINES.map((b) => [b, [] as BaselineMetrics[]])) as Record<
    BaselineName,
    BaselineMetrics[]
  >;
  for (let e = 0; e < nEvents; e++) {
    const truth = Math.round(60 + rng() * 240);
    const key = `${sc.name}-${e}`;
    const world = makeWorld(sc, truth, key);
    const policies = drawPolicies(rng, truth, N_POLICIES, opts.spread ?? 30, PAYOUT);
    tiesMs.push(await playTies(stack, world, policies, holders));
    for (const b of BASELINES) {
      baseMs[b].push(
        await playBaseline(
          baselines[b],
          stack,
          e + 1,
          b,
          committeeOracles,
          world,
          policies,
          holders,
        ),
      );
    }
  }
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(
    path.join(rawDir, `${sc.name}.json`),
    JSON.stringify({ ties: tiesMs, baselines: baseMs }),
  );
  return {
    ties: aggTies(tiesMs),
    baselines: Object.fromEntries(BASELINES.map((b) => [b, aggBaseline(baseMs[b])])) as Record<
      BaselineName,
      BaselineAgg
    >,
  };
}

// ----------------------------------------------------------------------------- gas vs n

interface GasPoint {
  n: number;
  tiesFinalizeRound: number;
  tiesApplyDefault: number | null;
  baselines: Record<BaselineName, number | "exceeds block gas limit">;
}

async function gasVsPolicies(sizes: number[]): Promise<GasPoint[]> {
  const sc = { name: "gas", committee: ["n1", "n2", "n3"], sources: {}, nodes: {} };
  const stack = await freshStack(sc.committee);
  const baselines = await freshBaselines(stack);
  const holders = await holdersOf(stack);
  const out: GasPoint[] = [];
  const blockLimit = Number((await ethers.provider.getBlock("latest"))!.gasLimit);
  for (const n of sizes) {
    const truth = 360;
    const world = makeWorld(sc, truth, `gas-${n}`);
    const policies = Array.from({ length: n }, (_, i) => ({
      bucket: 1 + Math.floor((i * 719) / n),
      payoutEth: "0.01",
    }));
    const eventId = Number(await createFlightEvent(stack.book, 100_000, 100_200));
    for (let i = 0; i < n; i++) {
      await bindPolicy(
        stack,
        holders[i % holders.length] as typeof stack.alice,
        eventId,
        policies[i].bucket,
        ethers.parseEther("0.01"),
      );
    }
    const meta = await stack.book.eventMeta(eventId);
    await time.increaseTo(Number(meta.observationEnd));
    await stack.engine.openRound(eventId);
    const st = await stack.engine.eventState(eventId);
    const reports: Awaited<ReturnType<typeof signReport>>[] = [];
    for (let i = 0; i < 3; i++) {
      const value = BigInt(Math.round(world.read(ORACLE_SOURCES[i])! * 1000));
      const r = await signReport(stack, stack.sourceWallets[ORACLE_SOURCES[i] - 1], eventId, value);
      await stack.engine
        .connect(stack.oracles[i])
        .commit(eventId, 1, commitHash(r, SALT, stack.oracles[i].address));
      reports.push(r);
    }
    await time.increaseTo(Number(st.commitDeadline));
    for (let i = 0; i < 3; i++) {
      const r = reports[i];
      await stack.engine
        .connect(stack.oracles[i])
        .reveal(
          eventId,
          1,
          r.value,
          r.ts,
          r.toolHash,
          r.argsHash,
          r.responseHash,
          r.sourceSig,
          SALT,
        );
    }
    await time.increaseTo(Number(st.revealDeadline));
    const rc = await (await stack.engine.finalizeRound(eventId)).wait();
    const after = await stack.engine.eventState(eventId);
    let applyDefault: number | null = null;
    if (Number(after.status) === 3) {
      await time.increaseTo(Number(after.challengeDeadline));
      applyDefault = Number(
        (await (await stack.engine.applyDefault(eventId)).wait())?.gasUsed ?? 0n,
      );
    }
    const point: GasPoint = {
      n,
      tiesFinalizeRound: Number(rc?.gasUsed ?? 0n),
      tiesApplyDefault: applyDefault,
      baselines: {} as GasPoint["baselines"],
    };
    for (const b of BASELINES) {
      const m = await playBaseline(
        baselines[b],
        stack,
        n * 10 + 1,
        b,
        [0, 1, 2],
        world,
        policies,
        holders,
      );
      point.baselines[b] = m.exceedsBlockLimit ? "exceeds block gas limit" : m.settleGas;
    }
    log(
      `gas n=${n}: TIES finalizeRound ${point.tiesFinalizeRound}, baselines ${JSON.stringify(point.baselines)} (block limit ${blockLimit})`,
    );
    out.push(point);
  }
  return out;
}

// ----------------------------------------------------------------------------- sweeps

async function sweepCompromised(): Promise<Record<string, unknown>[]> {
  const rows = [];
  for (const k of [0, 1, 2, 3]) {
    const sources = Object.fromEntries(
      Array.from({ length: k }, (_, i) => [`S${i + 1}`, { mode: "offset" as const, offset: 90 }]),
    );
    const r = await runScenario(
      { name: `compromised-${k}`, committee: ["n1", "n2", "n3"], sources, nodes: {} },
      SWEEP_EVENTS,
      { seedOffset: 100 + k },
    );
    rows.push({
      compromisedSources: k,
      ties: r.ties.wrongRate,
      ...Object.fromEntries(BASELINES.map((b) => [b, r.baselines[b].wrongRate])),
    });
    log(`compromised sources ${k}: TIES wrong ${(r.ties.wrongRate * 100).toFixed(2)}%`);
  }
  return rows;
}

async function sweepUMin(): Promise<Record<string, unknown>[]> {
  const rows = [];
  for (const u of ["0.4", "0.8", "2", "4", "8", "16"]) {
    const r = await runScenario(
      { name: `umin-${u}`, committee: ["n1", "n2", "n3"], sources: {}, nodes: {} },
      SWEEP_EVENTS,
      {
        overrides: { uMin: ethers.parseEther(u) },
        seedOffset: 200,
      },
    );
    rows.push({
      uMinEth: Number(u),
      oracleTxsPerEvent: r.ties.oracleTxsPerEvent,
      roundsPerEvent: r.ties.roundsPerEvent,
      wrongRate: r.ties.wrongRate,
      autoRate: r.ties.autoRate,
    });
    log(`u_min ${u}: ${r.ties.oracleTxsPerEvent.toFixed(2)} oracle txs/event`);
  }
  return rows;
}

async function sweepAlpha(): Promise<Record<string, unknown>[]> {
  const rows = [];
  for (const alpha of [0.2, 0.1, 0.05, 0.01, 0.001]) {
    const z = [1, 2, 3].map((r) => zForRound(alpha, r));
    const r = await runScenario(
      { name: `alpha-${alpha}`, committee: ["n1", "n2", "n3"], sources: {}, nodes: {} },
      SWEEP_EVENTS,
      {
        overrides: { zByRound: z.map((v) => BigInt(Math.round(v * 1e6)) * 10n ** 12n) },
        seedOffset: 300,
      },
    );
    rows.push({
      alpha,
      z1: z[0],
      autoRate: r.ties.autoRate,
      defaultRate: r.ties.defaultRate,
      wrongRate: r.ties.wrongRate,
      oracleTxsPerEvent: r.ties.oracleTxsPerEvent,
    });
    log(`alpha ${alpha}: auto ${(r.ties.autoRate * 100).toFixed(1)}%`);
  }
  return rows;
}

// ------------------------------------------------------------------------------- output

function csv(file: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const body = rows.map((r) => cols.map((c) => String(r[c])).join(","));
  fs.writeFileSync(path.join(resultsDir, file), [cols.join(","), ...body].join("\n") + "\n");
}

async function main() {
  const started = Date.now();
  fs.mkdirSync(resultsDir, { recursive: true });
  log(
    `network ${network.name}; ${N_EVENTS} events x ${N_POLICIES} policies per scenario; sweeps ${SWEEP_EVENTS} events; seed ${SEED}`,
  );

  const scenarios: Record<string, ScenarioResult & { title: string; description: string }> = {};
  for (const sc of EXPERIMENT_SCENARIOS) {
    const spread = sc.name === "borderline" ? 2 : 30;
    const r = await runScenario(sc, N_EVENTS, { spread });
    scenarios[sc.name] = { ...r, title: sc.title, description: sc.description };
    log(
      `${sc.name}: TIES wrong ${(r.ties.wrongRate * 100).toFixed(2)}% auto ${(r.ties.autoRate * 100).toFixed(1)}% oracle txs ${r.ties.oracleTxsPerEvent.toFixed(2)} | ` +
        BASELINES.map((b) => `${b} wrong ${(r.baselines[b].wrongRate * 100).toFixed(2)}%`).join(
          ", ",
        ),
    );
  }

  const sizes = QUICK ? [10, 50] : [10, 50, 100, 250, 500, 1000];
  const gas = await gasVsPolicies(sizes);
  const compromised = await sweepCompromised();
  const uMin = await sweepUMin();
  const alpha = await sweepAlpha();

  const summary = {
    generatedAt: new Date().toISOString(),
    config: {
      eventsPerScenario: N_EVENTS,
      policiesPerEvent: N_POLICIES,
      sweepEvents: SWEEP_EVENTS,
      seed: SEED,
      payoutEthPerPolicy: PAYOUT,
      network: "hardhat in-process, chain 31337",
      params: {
        uMinEth: Number(FLIGHT_DELAY_PARAMS.uMin) / 1e18,
        zByRound: FLIGHT_DELAY_PARAMS.zByRound.map((z) => Number(z) / 1e18),
      },
      notes: [
        "Each scenario uses a fresh deployment; reputations and dependence learned in one event carry into the next.",
        "Baselines receive the same source readings as TIES. A forged report is accepted by a baseline (no source signature) and rejected by TIES.",
        "BaselineMedian7 asks seven oracle keys: six distinct sources plus a second key on S2, because flight data has only six sources.",
        "Disputed events are left for the admin: their policies count as held, not as wrong.",
        "Late oracles are modelled as not revealing (their reveal would revert after the window).",
        "Policies are bound by three rotating holders. A baseline's per-policy loop gets cheaper when holders repeat (warm storage), so baseline settle gas here is a lower bound.",
        "Claims are not measured: TIES pays out one claim transaction per paying policy; the baselines pay one claim per holder.",
      ],
    },
    scenarios,
    gasVsPolicies: gas,
    sweeps: { compromisedSources: compromised, uMin, alpha },
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
  };
  fs.writeFileSync(path.join(resultsDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  csv(
    "scenarios.csv",
    Object.entries(scenarios).flatMap(([name, r]) => [
      {
        scenario: name,
        system: "ties",
        wrongRate: r.ties.wrongRate,
        autoRate: r.ties.autoRate,
        defaultRate: r.ties.defaultRate,
        heldRate: r.ties.heldRate,
        oracleTxsPerEvent: r.ties.oracleTxsPerEvent,
        oracleGasPerEvent: r.ties.oracleGasPerEvent,
        settleGasPerEvent: r.ties.settleGasPerEvent,
        gasPerPolicy: r.ties.gasPerPolicy,
        roundsPerEvent: r.ties.roundsPerEvent,
      },
      ...BASELINES.map((b) => ({
        scenario: name,
        system: b,
        wrongRate: r.baselines[b].wrongRate,
        autoRate: r.baselines[b].settledRate,
        defaultRate: 0,
        heldRate: 1 - r.baselines[b].settledRate,
        oracleTxsPerEvent: r.baselines[b].oracleTxsPerEvent,
        oracleGasPerEvent: r.baselines[b].oracleGasPerEvent,
        settleGasPerEvent: r.baselines[b].settleGasPerEvent,
        gasPerPolicy: r.baselines[b].gasPerPolicy,
        roundsPerEvent: 1,
      })),
    ]),
  );
  csv(
    "gas_vs_policies.csv",
    gas.map((g) => ({
      n: g.n,
      ties_finalizeRound: g.tiesFinalizeRound,
      ties_applyDefault: g.tiesApplyDefault ?? "",
      ...Object.fromEntries(BASELINES.map((b) => [b, g.baselines[b]])),
    })),
  );
  csv("sweep_compromised.csv", compromised);
  csv("sweep_umin.csv", uMin);
  csv("sweep_alpha.csv", alpha);

  const pub = path.join(root, "..", "frontend", "public", "experiments");
  fs.mkdirSync(pub, { recursive: true });
  fs.copyFileSync(path.join(resultsDir, "summary.json"), path.join(pub, "latest.json"));
  log(
    `done in ${summary.elapsedSeconds}s; wrote experiments/results/summary.json and frontend/public/experiments/latest.json`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
