import { Contract, JsonRpcProvider, formatEther, parseEther } from "ethers";
import {
  ACCOUNTS,
  DeploymentWatcher,
  PORTS,
  SOURCES,
  TiesContracts,
  chainNow,
  connectContracts,
  describeError,
  errorMessage,
  getJson,
  hardhatSigner,
  Logger,
  postJson,
  sleep,
  Deployment,
} from "../../shared/src";
import { rainfallMm } from "../../sources/src/openMeteo";
import { ScenarioDef, scenarioByName } from "../../../experiments/scenarios";
import { loadNodeConfig } from "../../../scripts/lib/seed";
import { TxWatcher, TxRecord } from "./txWatcher";

export const STATUS_NAMES = [
  "NONE",
  "ROUND_COMMIT",
  "ROUND_REVEAL",
  "DEFAULT_PENDING",
  "DISPUTED",
  "FINAL",
];
const OUTCOME_NAMES = ["INSUFFICIENT", "VALID", "DISPUTED"];

export type RunEvent =
  | { type: "log"; message: string }
  | {
      type: "step";
      id: string;
      label: string;
      status: "pending" | "mined" | "reverted" | "done" | "failed";
      hash?: string;
      gasUsed?: string;
      by?: string;
    }
  | { type: "tx"; tx: TxRecord }
  | { type: "round"; round: RoundRow }
  | { type: "event"; eventId: number; label: string; unit: string }
  | { type: "result"; result: ScenarioResult }
  | { type: "error"; message: string };

export interface RoundRow {
  round: number;
  outcome: string;
  value: number;
  sigma: number;
  nEff: number;
  lower: number;
  upper: number;
  payCursor: number;
  noPayCursor: number;
  newPay: string;
  newNoPay: string;
  held: string;
}

export interface PolicyRow {
  id: number;
  holder: string;
  bucket: number;
  payout: string;
  decision: "pays" | "no-pay" | "held";
  correct: boolean | null;
  /** What decided it: the evidence rounds, or the default rule / admin after them. */
  settledBy: "evidence" | "default" | null;
}

export interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioResult {
  scenario: string;
  eventId: number;
  truth: number;
  status: string;
  finalValue: number | null;
  rounds: RoundRow[];
  policies: PolicyRow[];
  wrongSettlements: number;
  revertedTxs: number;
  txCount: number;
  gasTotal: string;
  checks: Check[];
  ok: boolean;
}

export interface RunnerUrls {
  source: (sourceId: number) => string;
  oracle: string;
  /** Keeper control endpoint; optional so runners without a keeper still work. */
  keeper?: string;
}

export const defaultUrls = (): RunnerUrls => ({
  source: (id) => `http://127.0.0.1:${SOURCES.find((s) => s.id === id)!.port}`,
  oracle: `http://127.0.0.1:${PORTS.oracleNode}`,
  keeper: `http://127.0.0.1:${PORTS.keeper}`,
});

interface OracleStatus {
  nodes: {
    id: string;
    address: string;
    category: number;
    running: boolean;
    mode: string;
    tasks: { eventId: number; round: number; state: string }[];
  }[];
}

const COMMIT_DONE = [
  "committed",
  "revealed",
  "silent",
  "missed",
  "expired",
  "failed",
  "reveal_failed",
];
const REVEAL_DONE = ["revealed", "silent", "missed", "expired", "failed", "reveal_failed"];

/** Drives one scenario end to end against the running stack and reports every step. */
export class ScenarioRunner {
  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly deployments: DeploymentWatcher,
    private readonly log: Logger,
    private readonly urls: RunnerUrls = defaultUrls(),
  ) {}

  private contracts(): { d: Deployment; c: TiesContracts } {
    const d = this.deployments.current();
    if (!d) throw new Error("contracts are not deployed; start the stack first");
    return { d, c: connectContracts(d, this.provider) };
  }

  async advanceTo(timestamp: number): Promise<void> {
    const now = await chainNow(this.provider);
    const delta = Math.max(timestamp - now, 1);
    await this.provider.send("evm_increaseTime", [delta]);
    await this.provider.send("evm_mine", []);
  }

  async run(name: string, emit: (e: RunEvent) => void): Promise<ScenarioResult> {
    const sc = scenarioByName(name);
    const { c, d } = this.contracts();
    const admin = hardhatSigner(ACCOUNTS.admin, this.provider);
    const adminC = (k: Contract) => k.connect(admin) as Contract;
    const startBlock = (await this.provider.getBlockNumber()) + 1;
    const watcher = new TxWatcher(this.provider, d, startBlock);
    let step = 0;
    const say = (message: string) => emit({ type: "log", message });
    // Scenarios rely on the keeper; resume it in case the presenter paused it.
    if (this.urls.keeper) {
      try {
        const k = await getJson<{ paused: boolean }>(`${this.urls.keeper}/status`);
        if (k.paused) {
          await postJson(`${this.urls.keeper}/resume`);
          say("keeper was paused; resumed it for this scenario");
        }
      } catch {
        say("keeper control endpoint not reachable; continuing");
      }
    }
    const poll = setInterval(() => {
      void watcher.poll().then((txs) => txs.forEach((tx) => emit({ type: "tx", tx })));
    }, 300);
    const ownTx = async (
      label: string,
      send: () => Promise<{
        hash: string;
        wait(): Promise<{ gasUsed: bigint; status: number | null } | null>;
      }>,
      by: string,
    ) => {
      const id = `s${++step}`;
      emit({ type: "step", id, label, status: "pending", by });
      try {
        const tx = await send();
        const receipt = await tx.wait();
        emit({
          type: "step",
          id,
          label,
          status: "mined",
          hash: tx.hash,
          gasUsed: String(receipt?.gasUsed ?? ""),
          by,
        });
      } catch (err) {
        emit({ type: "step", id, label, status: "failed", by });
        throw new Error(
          `${label}: ${describeError([c.engine.interface, c.book.interface, c.registry.interface, c.vault.interface], err)}`,
        );
      }
    };

    try {
      say(`scenario "${sc.name}": ${sc.description}`);
      await this.reset(sc);
      const category = sc.category === "FLIGHT" ? 0 : 1;

      // Round-1 committee: the registry flag decides who is on it.
      const nodes = loadNodeConfig().filter((n) => n.category === category);
      for (const n of nodes) {
        const address = await hardhatSigner(n.account, this.provider).getAddress();
        const primary = sc.committee.includes(n.id);
        await ownTx(
          `registry: ${n.id} (S${n.sourceId}) ${primary ? "joins" : "leaves"} the committee`,
          () => adminC(c.registry).updateOracle(address, category, n.sourceId, primary, true),
          "admin",
        );
      }

      // Ground truth and the event.
      const eventNo = Number(await c.book.eventCount()) + 1;
      const key =
        category === 0
          ? `AI101|2027-01-${String((eventNo % 28) + 1).padStart(2, "0")}`
          : "13.08,80.27|2025-10-22";
      let truth: number;
      if (sc.truth === "real") {
        truth = await rainfallMm(13.08, 80.27, "2025-10-22", this.log);
        say(`Open-Meteo reports ${truth} mm for Chennai on 2025-10-22`);
      } else {
        truth = sc.truth;
      }
      // All mock sources share one truth store, so one call sets it for every source.
      await postJson(`${this.urls.source(1)}/truth`, { [key]: truth });
      const now = await chainNow(this.provider);
      const cutoff = now + 600;
      const observationEnd = now + 900;
      const label =
        category === 0 ? `AI 101 DEL-BOM (${sc.title})` : `Chennai rainfall (${sc.title})`;
      await ownTx(
        `book: create event "${label}"`,
        () => adminC(c.book).createEvent(category, label, key, cutoff, observationEnd),
        "admin",
      );
      const eventId = Number(await c.book.eventCount());
      emit({ type: "event", eventId, label, unit: category === 0 ? "min" : "mm" });

      // A policy may lock at most a quarter of the free liquidity, so make sure the vault is deep
      // enough for this scenario (earlier demo events keep part of it locked).
      const total = sc.policies.reduce((a, p) => a + parseEther(p.payout), 0n);
      const free = (await c.vault.freeLiquidity()) as bigint;
      const need = total * 5n + parseEther("1");
      if (free < need) {
        const topUp = need - free;
        await ownTx(
          `vault: LP #1 adds ${formatEther(topUp)} ETH of liquidity`,
          () =>
            (c.vault.connect(hardhatSigner(1, this.provider)) as Contract).deposit({
              value: topUp,
            }),
          "LP #1",
        );
      }

      const policyIds: { id: number; spec: (typeof sc.policies)[number] }[] = [];
      for (const p of sc.policies) {
        const holder = hardhatSigner(p.holder, this.provider);
        const payout = parseEther(p.payout);
        const premium = (await c.book.quote(eventId, p.bucket, payout)) as bigint;
        await ownTx(
          `book: #${p.holder} binds ${p.payout} ETH at ${p.bucket}`,
          () =>
            (c.book.connect(holder) as Contract).bind(eventId, p.bucket, payout, {
              value: premium,
            }),
          `#${p.holder}`,
        );
        policyIds.push({ id: Number(await c.book.policyCount()), spec: p });
      }

      say("advancing time to the end of the observation window");
      await this.advanceTo(observationEnd);
      await this.driveRounds(c, eventId, sc, emit, say, async () => {
        if (!sc.challenge) return false;
        say("a challenger disputes the pending default and posts the bond");
        const bond = (await c.engine.CHALLENGE_BOND()) as bigint;
        await ownTx(
          `engine: challenge(${eventId}) with a ${formatEther(bond)} ETH bond`,
          () =>
            (
              c.engine.connect(hardhatSigner(ACCOUNTS.challenger, this.provider)) as Contract
            ).challenge(eventId, { value: bond }),
          "challenger #18",
        );
        return true;
      });

      let st = await c.engine.eventState(eventId);
      if (Number(st.status) === 4 && sc.resolveDispute) {
        say("event is disputed; the admin resolves it at the true value");
        await ownTx(
          `engine: resolveDispute(${truth})`,
          () => adminC(c.engine).resolveDispute(eventId, BigInt(Math.round(truth * 1000))),
          "admin",
        );
        st = await c.engine.eventState(eventId);
      }

      // Winners claim: one O(1) transaction each.
      const cursor = Number(await c.engine.payCursor(eventId));
      for (const { id, spec } of policyIds) {
        if (Number(st.status) === 5 && spec.bucket <= cursor) {
          await ownTx(
            `book: #${spec.holder} claims policy ${id} (${spec.payout} ETH)`,
            () => (c.book.connect(hardhatSigner(spec.holder, this.provider)) as Contract).claim(id),
            `#${spec.holder}`,
          );
        }
      }

      await sleep(500);
      const txs = await watcher.poll();
      txs.forEach((tx) => emit({ type: "tx", tx }));
      const result = await this.summarise(sc, c, eventId, truth, policyIds, watcher);
      emit({ type: "result", result });
      return result;
    } catch (err) {
      emit({ type: "error", message: errorMessage(err) });
      throw err;
    } finally {
      clearInterval(poll);
    }
  }

  /** Puts sources and oracle nodes back to a known state, then applies the scenario's behaviour. */
  private async reset(sc: ScenarioDef): Promise<void> {
    const status = await getJson<OracleStatus>(`${this.urls.oracle}/status`);
    for (const n of status.nodes) {
      await postJson(`${this.urls.oracle}/nodes/${n.id}/start`);
      await postJson(`${this.urls.oracle}/nodes/${n.id}/mode`, {
        mode: sc.nodes?.[n.id] ?? "honest",
      });
    }
    for (const s of SOURCES) {
      const b = sc.sources?.[s.key] ?? {};
      await postJson(`${this.urls.source(s.id)}/control`, {
        mode: b.mode ?? "honest",
        offset: b.offset ?? 0,
        sigma: b.sigma ?? s.sigma,
        delayMs: b.delayMs ?? 0,
        down: b.down ?? false,
      });
    }
  }

  private async waitFor(
    cond: () => Promise<boolean>,
    timeoutMs: number,
    what: string,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await cond()) return true;
      await sleep(250);
    }
    this.log.warn(`timed out waiting for ${what}`);
    return false;
  }

  /** Waits for the oracle nodes on the committee of `round` to reach one of the given task states. */
  private async nodesSettled(
    c: TiesContracts,
    eventId: number,
    round: number,
    done: string[],
    skipLate: boolean,
  ) {
    const committee = ((await c.engine.committeeOf(eventId, round)) as string[]).map((a) =>
      a.toLowerCase(),
    );
    const category = Number((await c.book.eventMeta(eventId)).category);
    const status = await getJson<OracleStatus>(`${this.urls.oracle}/status`);
    for (const n of status.nodes) {
      if (!n.running || n.category !== category || !committee.includes(n.address.toLowerCase()))
        continue;
      if (skipLate && n.mode === "late") continue;
      const t = n.tasks.find((x) => x.eventId === eventId && x.round === round);
      if (!t || !done.includes(t.state)) return false;
    }
    return true;
  }

  private async driveRounds(
    c: TiesContracts,
    eventId: number,
    sc: ScenarioDef,
    emit: (e: RunEvent) => void,
    say: (m: string) => void,
    onDefaultPending: () => Promise<boolean> = async () => false,
  ): Promise<void> {
    const seen = new Set<number>();
    for (let guard = 0; guard < 40; guard++) {
      const st = await c.engine.eventState(eventId);
      const status = Number(st.status);
      if (status === 5 || status === 4) return;
      const round = Number(st.round);

      if (status === 0) {
        await this.waitFor(
          async () => Number((await c.engine.eventState(eventId)).status) !== 0,
          15_000,
          "the keeper to open round 1",
        );
        continue;
      }
      if (status === 3) {
        if (await onDefaultPending()) continue;
        say("default pending: advancing past the challenge period");
        await this.advanceTo(Number(st.challengeDeadline));
        await this.waitFor(
          async () => Number((await c.engine.eventState(eventId)).status) !== 3,
          15_000,
          "the keeper to apply the default",
        );
        continue;
      }
      // Commit and reveal phases of `round`.
      if (!seen.has(round)) {
        seen.add(round);
        say(`round ${round} is open`);
      }
      await this.waitFor(
        () => this.nodesSettled(c, eventId, round, COMMIT_DONE, false),
        20_000,
        `round ${round} commits`,
      );
      await this.advanceTo(Number(st.commitDeadline));
      await this.waitFor(
        () => this.nodesSettled(c, eventId, round, REVEAL_DONE, true),
        20_000,
        `round ${round} reveals`,
      );
      await this.advanceTo(Number(st.revealDeadline));
      await this.waitFor(
        async () => {
          const s = await c.engine.eventState(eventId);
          return Number(s.round) !== round || ![1, 2].includes(Number(s.status));
        },
        20_000,
        `the keeper to finalize round ${round}`,
      );
      const rows = await this.roundRows(c, eventId);
      const row = rows.find((r) => r.round === round);
      if (row) emit({ type: "round", round: row });
      if (sc.nodes && Object.values(sc.nodes).includes("late")) await sleep(300);
    }
    throw new Error("scenario did not reach a final or disputed state");
  }

  private async roundRows(c: TiesContracts, eventId: number): Promise<RoundRow[]> {
    const logs = await c.engine.queryFilter(c.engine.filters.RoundFinalized(eventId), 0, "latest");
    return logs.map((l) => {
      const a = (l as unknown as { args: Record<string, bigint> }).args;
      return {
        round: Number(a.round),
        outcome: OUTCOME_NAMES[Number(a.status)],
        value: Number(a.V) / 1000,
        sigma: Number(a.sigma) / 1000,
        nEff: Number(a.nEff) / 1e18,
        lower: Number(a.L) / 1000,
        upper: a.U > 10n ** 30n ? Infinity : Number(a.U) / 1000,
        payCursor: Number(a.payCursor),
        noPayCursor: Number(a.noPayCursor),
        newPay: String(a.newPay),
        newNoPay: String(a.newNoPay),
        held: String(a.held),
      };
    });
  }

  private async summarise(
    sc: ScenarioDef,
    c: TiesContracts,
    eventId: number,
    truth: number,
    policyIds: { id: number; spec: ScenarioDef["policies"][number] }[],
    watcher: TxWatcher,
  ): Promise<ScenarioResult> {
    const st = await c.engine.eventState(eventId);
    const status = STATUS_NAMES[Number(st.status)];
    const payCursor = Number(await c.engine.payCursor(eventId));
    const noPayCursor = Number(await c.engine.noPayCursor(eventId));
    const rounds = await this.roundRows(c, eventId);
    const finalLogs = await c.engine.queryFilter(
      c.engine.filters.EventFinalized(eventId),
      0,
      "latest",
    );
    const finalValue = finalLogs.length
      ? Number((finalLogs[0] as unknown as { args: { finalValue: bigint } }).args.finalValue) / 1000
      : null;

    // Cursors reached by the evidence rounds alone; anything settled beyond them was decided
    // afterwards by the default rule (or by the admin on a dispute).
    const lastRound = rounds[rounds.length - 1];
    const evidencePay = lastRound ? lastRound.payCursor : -1;
    const evidenceNoPay = lastRound ? lastRound.noPayCursor : Number.MAX_SAFE_INTEGER;
    const policies: PolicyRow[] = policyIds.map(({ id, spec }) => {
      const decision =
        spec.bucket <= payCursor ? "pays" : spec.bucket >= noPayCursor ? "no-pay" : "held";
      const shouldPay = truth >= spec.bucket;
      const byEvidence = spec.bucket <= evidencePay || spec.bucket >= evidenceNoPay;
      return {
        id,
        holder: `#${spec.holder}`,
        bucket: spec.bucket,
        payout: spec.payout,
        decision,
        correct: decision === "held" ? null : (decision === "pays") === shouldPay,
        settledBy: decision === "held" ? null : byEvidence ? "evidence" : "default",
      };
    });
    const wrong = policies.filter((p) => p.correct === false).length;
    const wrongByEvidence = policies.filter(
      (p) => p.correct === false && p.settledBy === "evidence",
    ).length;
    const txs = watcher.records;
    const reverted = txs.filter((t) => t.status === "reverted");
    const revealReverts = reverted.filter((t) => t.method === "reveal").length;
    const gasTotal = txs.reduce((a, t) => a + BigInt(t.gasUsed), 0n);

    const checks: Check[] = [];
    const e = sc.expect;
    if (e.finalStatus) {
      checks.push({
        label: `event ends ${e.finalStatus}`,
        pass: status === e.finalStatus,
        detail: status,
      });
    }
    if (e.maxWrongSettlements !== undefined) {
      // The default rule settles what the evidence could not, at the last consensus value, so
      // policies a few units from the truth can go the wrong way there (as in "borderline").
      // The check is about what the evidence decided; default errors are reported alongside.
      checks.push({
        label: `at most ${e.maxWrongSettlements} wrong settlements by evidence`,
        pass: wrongByEvidence <= e.maxWrongSettlements,
        detail: `${wrongByEvidence} wrong by evidence, ${wrong - wrongByEvidence} wrong by the default rule`,
      });
    }
    if (e.firstRound) {
      checks.push({
        label: `round 1 is ${e.firstRound}`,
        pass: rounds[0]?.outcome === e.firstRound,
        detail: rounds[0]?.outcome ?? "no round finalized",
      });
    }
    if (e.minRevertedReveals !== undefined) {
      checks.push({
        label: `at least ${e.minRevertedReveals} reveal(s) reverted`,
        pass: revealReverts >= e.minRevertedReveals,
        detail: `${revealReverts} reverted`,
      });
    }
    if (e.escalated) {
      checks.push({
        label: "evidence escalated to a later round",
        pass: rounds.length > 1,
        detail: `${rounds.length} rounds`,
      });
    }
    // Always: collateral must not move in a round that was INSUFFICIENT.
    const leaked = rounds.filter(
      (r) => r.outcome === "INSUFFICIENT" && (r.newPay !== "0" || r.newNoPay !== "0"),
    );
    checks.push({
      label: "no collateral moved on insufficient evidence",
      pass: leaked.length === 0,
      detail: leaked.length ? `moved in round ${leaked[0].round}` : "none moved",
    });

    return {
      scenario: sc.name,
      eventId,
      truth,
      status,
      finalValue,
      rounds,
      policies,
      wrongSettlements: wrong,
      revertedTxs: reverted.length,
      txCount: txs.length,
      gasTotal: gasTotal.toString(),
      checks,
      ok: checks.every((x) => x.pass),
    };
  }
}
