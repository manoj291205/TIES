import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  aggregate,
  Fenwick,
  FLIGHT_DELAY_PARAMS as P,
  flipShare,
  nextCursors,
  planEscalation,
  reputationWeight,
  roundInterval,
  settledAmounts,
  silentPenalty,
  updateDependence,
  updateReputation,
  WAD,
} from "../packages/ties-math/src";
import { createFlightEvent, eth, makeRng, FLIGHT_DELAY } from "./helpers/deploy";
import {
  bindPolicy,
  deployEngine,
  findLogs,
  milli,
  openFirstRound,
  OracleSpec,
  playCurrentRound,
  playUntilSettled,
  Responder,
} from "./helpers/engine";

const Status = { NONE: 0, COMMIT: 1, REVEAL: 2, DEFAULT_PENDING: 3, DISPUTED: 4, FINAL: 5 };
const Outcome = { INSUFFICIENT: 0, VALID: 1, DISPUTED: 2 };

interface PolicySpec {
  holder: "alice" | "bob";
  bucket: number;
  payout: bigint;
}

async function build(
  oracles: OracleSpec[],
  policies: PolicySpec[],
  overrides: Parameters<typeof deployEngine>[0] = {},
) {
  const stack = await deployEngine(overrides, { oracles });
  await stack.vault.connect(stack.lp1).deposit({ value: eth("100") });
  const eventId = await createFlightEvent(stack.book);
  for (const p of policies) {
    await bindPolicy(stack, stack[p.holder], eventId, p.bucket, p.payout);
  }
  await openFirstRound(stack, eventId);
  return { ...stack, eventId };
}

const prim = (source: number): OracleSpec => ({ source, primary: true });
const cand = (source: number): OracleSpec => ({ source, primary: false });

/** Reports by source id; sources not listed stay silent. */
const bySource =
  (values: Record<number, number>): Responder =>
  ({ source }) =>
    values[source] === undefined ? null : milli(values[source]);

const rhoPrior = (a: number, b: number): bigint => (a === b ? WAD : P.rho0);

describe("Escalation, recruitment and learning", () => {
  describe("worked example (flight AI 101)", () => {
    it("escalates to two unrepresented sources and settles as the spec computes", async () => {
      // Round 1: S1 reports 128, S2 reports 131 and 130 through two keys. Candidates for later
      // rounds are the ADS-B network (S4) and the airport FIDS (S5).
      const stack = await build(
        [prim(1), prim(2), prim(2), cand(4), cand(5)],
        [
          { holder: "alice", bucket: 125, payout: eth("5") },
          { holder: "bob", bucket: 120, payout: eth("2") },
          { holder: "alice", bucket: 130, payout: eth("1") },
          { holder: "bob", bucket: 60, payout: eth("1") },
        ],
      );
      const { engine, eventId, oracles } = stack;
      const responder = bySource({ 1: 128, 2: 0, 4: 133, 5: 132 });
      const round1 = (ctx: Parameters<Responder>[0]) =>
        ctx.oracleIndex === 1 ? milli(131) : ctx.oracleIndex === 2 ? milli(130) : responder(ctx);

      // ---- round 1
      const r1 = await playCurrentRound(stack, eventId, round1);
      const ev1 = findLogs(stack, r1, "RoundFinalized")[0].args;
      const mirror1 = aggregate({
        x: [milli(128), milli(131), milli(130)],
        rep: [0, 1, 2].map(() => (WAD * 4n) / 5n),
        rho: [
          [WAD, P.rho0, P.rho0],
          [P.rho0, WAD, WAD],
          [P.rho0, WAD, WAD],
        ],
        s: P.s,
        sigmaFloor: P.sigmaFloor,
        delta: P.delta,
        dCut: P.dCut,
      });
      expect(mirror1.nEff).to.be.lt(P.nMin); // fewer than 1.8 independent sources
      expect(ev1.status).to.equal(Outcome.INSUFFICIENT);
      expect(ev1.nEff).to.equal(mirror1.nEff);
      expect(ev1.newPay).to.equal(0n);
      expect(ev1.newNoPay).to.equal(0n);
      expect(ev1.held).to.equal(eth("9"));

      // Escalation: held 9 ETH exceeds the 2 ETH trigger, the margin to the 125 bucket (5 ETH)
      // asks for more than two recruits, so the maximum of two is requested.
      const esc = findLogs(stack, r1, "EscalationRequested")[0].args;
      expect(esc.nextRound).to.equal(2);
      expect(esc.k).to.equal(2n);
      expect([...esc.selected].sort()).to.deep.equal(
        [oracles[3].address, oracles[4].address].sort(),
      );
      expect(esc.held).to.equal(eth("9"));
      expect((await engine.eventState(eventId)).round).to.equal(2);
      expect(await engine.committeeOf(eventId, 2)).to.deep.equal([...esc.selected]);

      // ---- round 2
      const r2 = await playCurrentRound(stack, eventId, responder);
      const ev2 = findLogs(stack, r2, "RoundFinalized")[0].args;
      const values = [128, 131, 130, 133, 132].map(milli);
      const sources = [1, 2, 2, 4, 5];
      const mirror2 = aggregate({
        x: values,
        rep: values.map(() => (WAD * 4n) / 5n),
        rho: values.map((_, i) => values.map((_, j) => rhoPrior(sources[i], sources[j]))),
        s: P.s,
        sigmaFloor: P.sigmaFloor,
        delta: P.delta,
        dCut: P.dCut,
      });
      const iv = roundInterval(mirror2.consensus, mirror2.sigma, P.zByRound[1]);
      expect(ev2.status).to.equal(Outcome.VALID);
      expect(ev2.V).to.equal(mirror2.consensus);
      expect(ev2.sigma).to.equal(mirror2.sigma);
      expect(ev2.nEff).to.equal(mirror2.nEff);
      expect(ev2.L).to.equal(iv.lo);
      expect(ev2.U).to.equal(iv.hi);

      const tree = new Fenwick(721);
      for (const [b, a] of [
        [125, eth("5")],
        [120, eth("2")],
        [130, eth("1")],
        [60, eth("1")],
      ] as const) {
        tree.add(b, a);
      }
      const next = nextCursors({ pay: -1, noPay: 721 }, 721, P.bucketWidth, iv.lo, iv.hi);
      const amounts = settledAmounts(tree, { pay: -1, noPay: 721 }, next);
      expect(ev2.payCursor).to.equal(BigInt(next.pay));
      expect(ev2.noPayCursor).to.equal(BigInt(next.noPay));
      expect(ev2.newPay).to.equal(amounts.newPay);
      expect(ev2.newNoPay).to.equal(amounts.newNoPay);
      expect(ev2.held).to.equal(eth("9") - amounts.newPay - amounts.newNoPay);

      // With a 1 ETH tolerance for held collateral: whatever is still held after round 2 is at
      // most 2 ETH, and no unrepresented source remains, so the event goes to a pending default
      // (or is final if nothing is held).
      const status = Number((await engine.eventState(eventId)).status);
      expect(status).to.equal(ev2.held === 0n ? Status.FINAL : Status.DEFAULT_PENDING);
      expect(findLogs(stack, r2, "EscalationRequested")).to.have.length(0);

      // The spec's rule (threshold <= L pays) decides these four policies:
      // L is the lower end of the interval, so thresholds up to floor(L) are paid.
      expect(next.pay).to.be.gte(60);
      expect(next.noPay).to.be.gt(next.pay);
    });
  });

  describe("recruitment", () => {
    it("recruits only unrepresented sources after a single-source round and eventually settles", async () => {
      const stack = await build(
        [prim(1), prim(2), prim(2), cand(3), cand(4), cand(5)],
        [
          { holder: "alice", bucket: 60, payout: eth("1") },
          { holder: "bob", bucket: 100, payout: eth("1") },
          { holder: "alice", bucket: 200, payout: eth("2") },
          { holder: "bob", bucket: 250, payout: eth("1") },
        ],
      );
      const { engine, eventId } = stack;
      // S1 stays silent in round 1; S2 reports through two keys: one source, N_eff = 1.
      const honest: Responder = ({ source, round }) =>
        source === 1 && round === 1 ? null : milli(128 + source);
      const receipts = await playUntilSettled(stack, eventId, honest);

      const first = findLogs(stack, receipts[0], "RoundFinalized")[0].args;
      expect(first.status).to.equal(Outcome.INSUFFICIENT);
      expect(first.nEff).to.equal(WAD);

      let represented = new Set<number>([2]);
      for (let i = 0; i < receipts.length; i++) {
        const requested = findLogs(stack, receipts[i], "EscalationRequested");
        if (requested.length === 0) continue;
        const args = requested[0].args;
        expect(args.selected.length).to.be.gt(0);
        expect(args.selected.length).to.be.lte(Number(args.k));
        expect(Number(args.k)).to.be.lte(2); // k_round
        for (const addr of args.selected) {
          const idx = stack.oracles.findIndex((o) => o.address === addr);
          const source = stack.oracleSource[idx];
          expect(represented.has(source), `source ${source} was already represented`).to.equal(
            false,
          );
        }
        // Everyone selected reports in the next round, so their sources become represented.
        for (const addr of args.selected) {
          represented.add(stack.oracleSource[stack.oracles.findIndex((o) => o.address === addr)]);
        }
      }
      represented = new Set();
      const st = await engine.eventState(eventId);
      expect(st.round).to.be.lte(3);
      expect(st.status).to.equal(Status.FINAL);
      expect(await stack.vault.locked()).to.equal(0n);
    });

    it("gives up on a margin that more sources cannot close (futility) and defaults", async () => {
      // All three sources report exactly 130, and 3 ETH sits at the 130 threshold: the interval
      // can never separate the value from the threshold.
      const stack = await build(
        [prim(1), prim(2), prim(3), cand(4)],
        [
          { holder: "alice", bucket: 130, payout: eth("3") },
          { holder: "bob", bucket: 60, payout: eth("1") },
        ],
      );
      const { engine, eventId, vault, book, alice } = stack;
      const receipt = await playCurrentRound(stack, eventId, () => milli(130));
      const ev = findLogs(stack, receipt, "RoundFinalized")[0].args;
      expect(ev.status).to.equal(Outcome.VALID);
      expect(ev.V).to.equal(milli(130));
      expect(ev.held).to.equal(eth("3"));
      expect(findLogs(stack, receipt, "EscalationRequested")).to.have.length(0);
      expect(findLogs(stack, receipt, "EventDefaultPending")).to.have.length(1);
      const st = await engine.eventState(eventId);
      expect(st.status).to.equal(Status.DEFAULT_PENDING);
      await time.increaseTo(Number(st.challengeDeadline));
      await engine.applyDefault(eventId);
      // The default pays at the last consensus: 130 >= 130, so the 130 policy pays.
      expect(await vault.claimable()).to.equal(eth("4"));
      await book.connect(alice).claim(1);
    });

    it("goes to a pending default when no unrepresented source can be recruited", async () => {
      const stack = await build(
        [prim(1), prim(2), prim(3)],
        [
          { holder: "alice", bucket: 125, payout: eth("3") },
          { holder: "bob", bucket: 60, payout: eth("1") },
        ],
      );
      const receipt = await playCurrentRound(
        stack,
        stack.eventId,
        bySource({ 1: 128, 2: 130, 3: 131 }),
      );
      expect(findLogs(stack, receipt, "EscalationRequested")).to.have.length(0);
      expect((await stack.engine.eventState(stack.eventId)).status).to.equal(
        Status.DEFAULT_PENDING,
      );
    });

    it("does not escalate for held collateral at or below the trigger on a valid round", async () => {
      const stack = await build(
        [prim(1), prim(2), prim(3), cand(4)],
        [
          { holder: "alice", bucket: 128, payout: eth("2") },
          { holder: "bob", bucket: 60, payout: eth("1") },
        ],
      );
      const receipt = await playCurrentRound(
        stack,
        stack.eventId,
        bySource({ 1: 128, 2: 130, 3: 131 }),
      );
      expect(findLogs(stack, receipt, "RoundFinalized")[0].args.held).to.equal(eth("2"));
      expect(findLogs(stack, receipt, "EscalationRequested")).to.have.length(0);
    });

    it("respects the per-round recruit limit and the round limit", async () => {
      // Only one oracle may be recruited per round (k_round = 1), so evidence builds up slowly.
      const stack = await build(
        [prim(1), cand(2), cand(3), cand(4), cand(5), cand(6)],
        [
          { holder: "alice", bucket: 60, payout: eth("3") },
          { holder: "bob", bucket: 200, payout: eth("3") },
        ],
        { kRound: 1 },
      );
      const receipts = await playUntilSettled(stack, stack.eventId, () => milli(130));
      const st = await stack.engine.eventState(stack.eventId);
      expect(st.round).to.be.lte(3);
      for (const r of receipts) {
        for (const log of findLogs(stack, r, "EscalationRequested")) {
          expect(Number(log.args.nextRound)).to.be.lte(3);
          expect(log.args.selected.length).to.be.lte(1); // k_round = 1
        }
      }
    });
  });

  describe("learning", () => {
    async function compromised() {
      // Five sources report in round 1; S2 is compromised (+90 min). S6 is on the committee but
      // never answers. Policies sit far from the interval so the event is final in round 1.
      const policies: PolicySpec[] = [
        { holder: "alice", bucket: 60, payout: eth("1") },
        { holder: "bob", bucket: 100, payout: eth("1") },
        { holder: "alice", bucket: 200, payout: eth("2") },
        { holder: "bob", bucket: 250, payout: eth("1") },
      ];
      const stack = await build([1, 2, 3, 4, 5, 6].map(prim), policies);
      const values: Record<number, number> = { 1: 128, 2: 220, 3: 131, 4: 130, 5: 132 };
      const receipt = await playCurrentRound(stack, stack.eventId, bySource(values));
      return { stack, receipt, policies, values };
    }

    it("outvotes a compromised source and settles without disputing", async () => {
      const { stack, receipt } = await compromised();
      const ev = findLogs(stack, receipt, "RoundFinalized")[0].args;
      expect(ev.status).to.equal(Outcome.VALID);
      expect(ev.held).to.equal(0n);
      expect(Number((await stack.engine.eventState(stack.eventId)).status)).to.equal(Status.FINAL);
      // V stays near the honest sources, not near the compromised 220.
      expect(ev.V).to.be.lt(milli(140));
      expect(ev.V).to.be.gt(milli(125));
    });

    it("lowers the compromised oracle's reputation exactly as the reference computes", async () => {
      const { stack, policies } = await compromised();
      const { engine, registry, oracles, eventId } = stack;
      const final = (await engine.eventState(eventId)).vLast;

      const tree = new Fenwick(721);
      let total = 0n;
      for (const p of policies) {
        tree.add(p.bucket, p.payout);
        total += p.payout;
      }
      const lp = { ...P };
      const start = { alpha: P.alpha0, beta: P.beta0 };
      const reported = [
        { idx: 0, value: milli(128) },
        { idx: 1, value: milli(220) },
        { idx: 2, value: milli(131) },
        { idx: 3, value: milli(130) },
        { idx: 4, value: milli(132) },
      ];
      for (const r of reported) {
        const flip = flipShare(tree, total, P.bucketWidth, r.value, final);
        const expected = updateReputation(lp, start, r.value, final, flip);
        const [alpha, beta] = await registry.reputation(oracles[r.idx].address, FLIGHT_DELAY);
        expect([alpha, beta], `oracle ${r.idx}`).to.deep.equal([expected.alpha, expected.beta]);
      }
      // The oracle that was never heard from is penalised once; alpha is untouched.
      const silent = silentPenalty(lp, start);
      const [alpha5, beta5] = await registry.reputation(oracles[5].address, FLIGHT_DELAY);
      expect([alpha5, beta5]).to.deep.equal([silent.alpha, silent.beta]);

      // The compromised source loses weight relative to the honest ones.
      const weight = async (i: number) =>
        reputationWeight({
          alpha: (await registry.reputation(oracles[i].address, FLIGHT_DELAY))[0],
          beta: (await registry.reputation(oracles[i].address, FLIGHT_DELAY))[1],
        });
      expect(await weight(1)).to.be.lt(await weight(0));
      expect(await weight(1)).to.be.lt((WAD * 4n) / 5n);
      expect(await weight(5)).to.be.lt((WAD * 4n) / 5n);
    });

    it("raises the learned dependence of two sources that err together", async () => {
      const stack = await build([1, 2, 3, 4, 5].map(prim), [
        { holder: "alice", bucket: 60, payout: eth("1") },
        { holder: "bob", bucket: 250, payout: eth("1") },
      ]);
      // S2 and S3 both read about 20 minutes high; the others agree.
      const values = { 1: 130, 2: 150, 3: 151, 4: 130, 5: 129 };
      await playCurrentRound(stack, stack.eventId, bySource(values));
      const st = await stack.engine.eventState(stack.eventId);
      expect(st.status).to.equal(Status.FINAL);

      const reports = [1, 2, 3, 4, 5].map((s) => ({
        source: s,
        value: milli(values[s as keyof typeof values]),
      }));
      const expected = updateDependence(P, reports, st.vLast, () => P.rho0);
      for (const u of expected) {
        expect(await stack.registry.dependence(u.a, u.b, P.rho0), `pair ${u.a}-${u.b}`).to.equal(
          u.rho,
        );
      }
      // (1 - mu) * 0.2 + mu * 1 = 0.36 for the pair that erred together; others fall back to 0.2.
      expect(await stack.registry.dependence(2, 3, P.rho0)).to.equal((WAD * 36n) / 100n);
      expect(await stack.registry.dependence(1, 4, P.rho0)).to.equal(P.rho0);
      expect(await stack.registry.dependence(2, 1, P.rho0)).to.equal(P.rho0);
    });

    it("emits the reputation and dependence updates", async () => {
      const stack = await build([1, 2, 3, 4, 5].map(prim), [
        { holder: "alice", bucket: 60, payout: eth("1") },
        { holder: "bob", bucket: 250, payout: eth("1") },
      ]);
      const receipt = await playCurrentRound(
        stack,
        stack.eventId,
        bySource({ 1: 130, 2: 150, 3: 151, 4: 130, 5: 129 }),
      );
      const names = new Set<string>();
      for (const log of receipt!.logs) {
        try {
          names.add(
            stack.registry.interface.parseLog({ topics: [...log.topics], data: log.data })!.name,
          );
        } catch {
          // not a registry event
        }
      }
      expect(names.has("ReputationUpdated")).to.equal(true);
      expect(names.has("DependenceUpdated")).to.equal(true);
    });

    it("learns from a dispute resolution and from a default as well", async () => {
      const stack = await build(
        [1, 2, 3].map(prim),
        [{ holder: "alice", bucket: 128, payout: eth("3") }],
        { rMin: 2n * WAD },
      );
      await playCurrentRound(stack, stack.eventId, bySource({ 1: 128, 2: 130, 3: 131 }));
      const before = await stack.registry.reputation(stack.oracles[0].address, FLIGHT_DELAY);
      const st = await stack.engine.eventState(stack.eventId);
      await time.increaseTo(Number(st.challengeDeadline));
      await stack.engine.applyDefault(stack.eventId);
      const after = await stack.registry.reputation(stack.oracles[0].address, FLIGHT_DELAY);
      expect(after[0]).to.not.equal(before[0]);
    });
  });

  describe("planner", () => {
    it("agrees with the TypeScript reference on the first round of a scripted event", async () => {
      const stack = await build(
        [prim(1), prim(2), prim(2), cand(3), cand(4), cand(5)],
        [
          { holder: "alice", bucket: 125, payout: eth("5") },
          { holder: "bob", bucket: 60, payout: eth("1") },
        ],
      );
      const { engine, eventId, oracles, oracleSource, registry } = stack;
      const receipt = await playCurrentRound(stack, eventId, ({ oracleIndex }) =>
        oracleIndex === 0 ? milli(128) : oracleIndex === 1 ? milli(131) : milli(130),
      );
      const args = findLogs(stack, receipt, "EscalationRequested")[0].args;

      const mirror = aggregate({
        x: [milli(128), milli(131), milli(130)],
        rep: [0, 1, 2].map(() => (WAD * 4n) / 5n),
        rho: [
          [WAD, P.rho0, P.rho0],
          [P.rho0, WAD, WAD],
          [P.rho0, WAD, WAD],
        ],
        s: P.s,
        sigmaFloor: P.sigmaFloor,
        delta: P.delta,
        dCut: P.dCut,
      });
      const rawBlock = await ethers.provider.send("eth_getBlockByNumber", [
        ethers.toBeHex(receipt!.blockNumber),
        false,
      ]);
      const prevRandao = BigInt(rawBlock.prevRandao ?? rawBlock.mixHash);
      const candidates = oracles.map((o, i) => ({
        oracle: o.address,
        source: oracleSource[i],
        reputation: (WAD * 4n) / 5n,
        tieBreak: BigInt(
          ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["uint256", "uint256", "address"],
              [prevRandao, eventId, o.address],
            ),
          ),
        ),
      }));
      const plan = planEscalation(
        {
          round: 1,
          hasConsensus: true,
          insufficient: true,
          payCursor: -1,
          noPayCursor: 721,
          consensus: mirror.consensus,
          sigma: mirror.sigma,
          nEff: mirror.nEff,
          sourceIds: [1, 2],
          sourceWeights: [mirror.weights[0], mirror.weights[1] + mirror.weights[2]],
          reporters: [oracles[0].address, oracles[1].address, oracles[2].address],
          bucketAmounts: (b) => (b === 125 ? eth("5") : b === 60 ? eth("1") : 0n),
        },
        P,
        candidates,
        rhoPrior,
      );
      expect(plan.escalate).to.equal(true);
      expect(BigInt(plan.k)).to.equal(args.k);
      expect([...args.selected]).to.deep.equal(plan.selected);
      // Three unrepresented candidates (S3, S4, S5) exist; two are chosen.
      expect(args.selected.length).to.equal(2);
      expect((await registry.activePrimaryOracles(FLIGHT_DELAY)).length).to.equal(3);
      void engine;
    });

    it("handles an event with no reports at all by asking for the maximum", async () => {
      const stack = await build(
        [prim(1), cand(2), cand(3)],
        [{ holder: "alice", bucket: 100, payout: eth("3") }],
      );
      const receipt = await playCurrentRound(stack, stack.eventId, () => null);
      const ev = findLogs(stack, receipt, "RoundFinalized")[0].args;
      expect(ev.status).to.equal(Outcome.INSUFFICIENT);
      const args = findLogs(stack, receipt, "EscalationRequested")[0].args;
      expect(args.k).to.equal(2n); // ceil(1.8 - 0)
      expect(args.selected.length).to.equal(2);
    });

    it("scans a short held range and a wide held range", async () => {
      // 100% of the held range fits the scan window: policies settled on both sides leave 20 buckets.
      const stack = await build(
        [prim(1), prim(2), prim(3), cand(4), cand(5)],
        [
          { holder: "alice", bucket: 124, payout: eth("3") },
          { holder: "bob", bucket: 60, payout: eth("1") },
        ],
      );
      const receipt = await playCurrentRound(
        stack,
        stack.eventId,
        bySource({ 1: 128, 2: 130, 3: 131 }),
      );
      expect(findLogs(stack, receipt, "RoundFinalized")[0].args.held).to.equal(eth("3"));
    });

    it("falls back to the bucket nearest the consensus when the scan window holds no collateral", async () => {
      // All collateral far from V: with a wide held range the scan around V finds nothing.
      const stack = await build(
        [prim(1), prim(2), cand(3), cand(4)],
        [
          { holder: "alice", bucket: 600, payout: eth("3") },
          { holder: "bob", bucket: 5, payout: eth("1") },
        ],
      );
      // Single source: INSUFFICIENT, so it still escalates (or is judged futile at the nearest bucket).
      const receipt = await playCurrentRound(stack, stack.eventId, ({ source }) =>
        source === 1 ? milli(130) : null,
      );
      expect(findLogs(stack, receipt, "RoundFinalized")[0].args.status).to.equal(
        Outcome.INSUFFICIENT,
      );
    });
  });

  describe("randomised property checks", () => {
    it("never exceeds k_round or K_max and never recruits a represented source", async function () {
      this.timeout(600_000);
      const rnd = makeRng(2718);
      for (let scenario = 0; scenario < 8; scenario++) {
        const kRound = 1 + rnd(2);
        const stack = await build(
          [prim(1), prim(2), prim(2), cand(3), cand(4), cand(5), cand(6), cand(2)],
          [
            { holder: "alice", bucket: 40 + rnd(200), payout: eth("2") },
            { holder: "bob", bucket: 40 + rnd(200), payout: eth("1") },
            { holder: "alice", bucket: 300 + rnd(100), payout: eth("2") },
          ],
          { kRound },
        );
        const truth = 60 + rnd(200);
        const responder: Responder = () => {
          const roll = rnd(10);
          if (roll === 0) return null; // silent
          if (roll === 1) return milli(truth + 80); // compromised
          return milli(truth - 5 + rnd(11)); // honest with noise
        };
        const receipts = await playUntilSettled(stack, stack.eventId, responder);
        const { engine, eventId } = stack;

        const st = await engine.eventState(eventId);
        expect(Number(st.round), `scenario ${scenario}`).to.be.lte(3);
        expect(
          (await stack.vault.freeLiquidity()) +
            (await stack.vault.locked()) +
            (await stack.vault.claimable()),
        ).to.equal(await ethers.provider.getBalance(await stack.vault.getAddress()));

        const finalCount = Number(await engine.reportCount(eventId));
        const allReports = [];
        for (let i = 0; i < finalCount; i++) allReports.push(await engine.reportAt(eventId, i));
        for (let i = 0; i < receipts.length; i++) {
          const roundsSoFar = i + 1;
          const before = allReports.filter((r) => Number(r.round) <= roundsSoFar);
          const seenOracles = new Set(before.map((r) => r.oracle));
          const seenSources = new Set(before.map((r) => Number(r.sourceId)));
          for (const log of findLogs(stack, receipts[i], "EscalationRequested")) {
            expect(log.args.selected.length).to.be.lte(kRound);
            expect(Number(log.args.nextRound)).to.be.lte(3);
            for (const addr of log.args.selected) {
              const idx = stack.oracles.findIndex((o) => o.address === addr);
              expect(seenOracles.has(addr), "recruited an oracle that already reported").to.equal(
                false,
              );
              expect(
                seenSources.has(stack.oracleSource[idx]),
                "recruited an oracle on a represented source",
              ).to.equal(false);
            }
          }
        }
      }
    });
  });

  describe("modules", () => {
    it("restricts learning to the engine and allows setting it only once", async () => {
      const { learning, alice, admin, engineAddress } = await deployEngine();
      await expect(
        learning.connect(alice).learn({
          eventId: 1,
          category: 0,
          version: 0,
          finalValue: 0,
          total: 0,
          oracles: [],
          sources: [],
          values: [],
          silent: [],
        }),
      ).to.be.revertedWithCustomError(learning, "NotEngine");
      expect(await learning.engine()).to.equal(engineAddress);
      await expect(learning.connect(admin).setEngine(alice.address)).to.be.revertedWithCustomError(
        learning,
        "EngineAlreadySet",
      );
      await expect(learning.connect(alice).setEngine(alice.address)).to.be.revertedWithCustomError(
        learning,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("exposes oracle and dependence views to the planner", async () => {
      const stack = await deployEngine(
        {},
        { oracles: [prim(1), cand(2), { source: 3, primary: false }] },
      );
      const { registry, oracles } = stack;
      await registry.updateOracle(oracles[2].address, FLIGHT_DELAY, 3, false, false);
      const [list, sources, weights] = await registry.activeOracleInfo(FLIGHT_DELAY);
      expect([...list]).to.deep.equal([oracles[0].address, oracles[1].address]);
      expect(sources.map(Number)).to.deep.equal([1, 2]);
      expect(weights.map(BigInt)).to.deep.equal([(WAD * 4n) / 5n, (WAD * 4n) / 5n]);
      expect((await registry.activePrimaryOracles(FLIGHT_DELAY)).length).to.equal(1);

      expect((await registry.dependenceVector(1, [1, 2, 3], P.rho0)).map(BigInt)).to.deep.equal([
        WAD,
        P.rho0,
        P.rho0,
      ]);
      const matrix = await registry.dependenceMatrix([1, 2], P.rho0);
      expect(matrix.map(BigInt)).to.deep.equal([WAD, P.rho0, P.rho0, WAD]);
    });
  });
});
