import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { FLIGHT_DELAY_PARAMS as P, WAD } from "../packages/ties-math/src";
import { createFlightEvent, eth, FLIGHT_DELAY } from "./helpers/deploy";
import {
  bindPolicy,
  deployEngine,
  findLogs,
  milli,
  openFirstRound,
  OracleSpec,
  playCurrentRound,
  playRound,
  playUntilSettled,
} from "./helpers/engine";

const Status = { NONE: 0, COMMIT: 1, REVEAL: 2, DEFAULT_PENDING: 3, DISPUTED: 4, FINAL: 5 };
const Reason = { INCONSISTENT_EVIDENCE: 0, CHALLENGED: 1, INSUFFICIENT_EVIDENCE: 2 };
const prim = (source: number): OracleSpec => ({ source, primary: true });
const cand = (source: number): OracleSpec => ({ source, primary: false });

async function build(
  oracles: OracleSpec[],
  policies: { bucket: number; payout: bigint }[],
  overrides: Parameters<typeof deployEngine>[0] = {},
) {
  const stack = await deployEngine(overrides, { oracles });
  await stack.vault.connect(stack.lp1).deposit({ value: eth("100") });
  const eventId = await createFlightEvent(stack.book);
  for (const p of policies) await bindPolicy(stack, stack.alice, eventId, p.bucket, p.payout);
  await openFirstRound(stack, eventId);
  return { ...stack, eventId };
}

describe("Settlement safety", () => {
  describe("single-source evidence never moves collateral, on any path (P1)", () => {
    it("disputes instead of defaulting when no round ever reached N_min", async () => {
      // Two keys read one feed (S2). Every recruit stays silent, so the evidence never becomes
      // sufficient. A policy sits exactly on the reported value, which makes the margin futile;
      // the engine must still recruit, because insufficient evidence cannot be trusted yet.
      const stack = await build(
        [prim(2), prim(2), cand(1), cand(3), cand(4)],
        [
          { bucket: 130, payout: eth("3") },
          { bucket: 60, payout: eth("1") },
        ],
      );
      const { engine, eventId, vault, admin } = stack;
      const lockedBefore = await vault.locked();
      const receipts = await playUntilSettled(stack, eventId, ({ source }) =>
        source === 2 ? milli(130) : null,
      );

      expect(findLogs(stack, receipts[0], "EscalationRequested")).to.have.length(1);
      for (const r of receipts) {
        const ev = findLogs(stack, r, "RoundFinalized")[0].args;
        expect(ev.newPay).to.equal(0n);
        expect(ev.newNoPay).to.equal(0n);
      }
      const st = await engine.eventState(eventId);
      expect(st.status).to.equal(Status.DISPUTED);
      expect(st.disputeReason).to.equal(Reason.INSUFFICIENT_EVIDENCE);
      expect(st.hasInterval).to.equal(false);
      expect(await vault.claimable()).to.equal(0n);
      expect(await vault.locked()).to.equal(lockedBefore);
      const last = receipts[receipts.length - 1];
      expect(findLogs(stack, last, "EventDisputed")[0].args.reason).to.equal(
        Reason.INSUFFICIENT_EVIDENCE,
      );

      // Nobody can force a default or a challenge; only the admin can resolve.
      await expect(engine.applyDefault(eventId)).to.be.revertedWithCustomError(
        engine,
        "WrongStatus",
      );
      await expect(engine.challenge(eventId, { value: eth("0.05") })).to.be.revertedWithCustomError(
        engine,
        "WrongStatus",
      );
      await engine.connect(admin).resolveDispute(eventId, milli(130));
      expect((await engine.eventState(eventId)).status).to.equal(Status.FINAL);
    });

    it("disputes immediately when no recruit is possible after an insufficient round", async () => {
      const stack = await build([prim(2), prim(2)], [{ bucket: 100, payout: eth("3") }]);
      const receipt = await playCurrentRound(stack, stack.eventId, () => milli(130));
      expect(findLogs(stack, receipt, "EscalationRequested")).to.have.length(0);
      expect(findLogs(stack, receipt, "EventDefaultPending")).to.have.length(0);
      const st = await stack.engine.eventState(stack.eventId);
      expect(st.status).to.equal(Status.DISPUTED);
      expect(st.disputeReason).to.equal(Reason.INSUFFICIENT_EVIDENCE);
    });
  });

  describe("escalation sizing", () => {
    it("imposes no margin when the scan window around V holds no collateral", async () => {
      const stack = await build(
        [prim(1), prim(2), cand(3), cand(4)],
        [
          { bucket: 600, payout: eth("3") },
          { bucket: 5, payout: eth("1") },
        ],
      );
      const receipt = await playCurrentRound(stack, stack.eventId, ({ source }) =>
        source === 1 ? milli(130) : null,
      );
      const args = findLogs(stack, receipt, "EscalationRequested")[0].args;
      // Only the sufficiency rule applies: ceil(1.8 - 1.0) = 1 recruit.
      expect(args.k).to.equal(1n);
      expect(args.selected.length).to.equal(1);
    });

    it("never recruits beyond the report capacity of the event", async () => {
      // Four reports at most; three are used in round 1, so only one of the two requested
      // recruits fits.
      const stack = await build(
        [prim(1), prim(2), prim(2), cand(3), cand(4), cand(5)],
        [
          { bucket: 125, payout: eth("5") },
          { bucket: 60, payout: eth("1") },
        ],
        { maxReportsPerEvent: 4 },
      );
      const receipt = await playCurrentRound(stack, stack.eventId, ({ oracleIndex }) =>
        oracleIndex === 0 ? milli(128) : oracleIndex === 1 ? milli(131) : milli(130),
      );
      const args = findLogs(stack, receipt, "EscalationRequested")[0].args;
      expect(args.k).to.equal(2n);
      expect(args.selected.length).to.equal(1);
      expect(await stack.engine.committeeOf(stack.eventId, 2)).to.have.length(1);
    });

    it("does not escalate when the report capacity is used up", async () => {
      const stack = await build(
        [prim(1), prim(2), prim(3), cand(4)],
        [
          { bucket: 125, payout: eth("5") },
          { bucket: 60, payout: eth("1") },
        ],
        { maxReportsPerEvent: 3 },
      );
      const receipt = await playCurrentRound(stack, stack.eventId, ({ source }) =>
        milli(127 + source),
      );
      expect(findLogs(stack, receipt, "EscalationRequested")).to.have.length(0);
      expect((await stack.engine.eventState(stack.eventId)).status).to.equal(
        Status.DEFAULT_PENDING,
      );
    });

    it("does not recruit oracles whose source is deactivated", async () => {
      const stack = await build(
        [prim(1), prim(2), prim(2), cand(3), cand(4)],
        [{ bucket: 125, payout: eth("5") }],
      );
      await stack.registry.setSourceActive(3, false);
      const receipt = await playCurrentRound(stack, stack.eventId, ({ oracleIndex }) =>
        oracleIndex === 0 ? milli(128) : milli(130),
      );
      const args = findLogs(stack, receipt, "EscalationRequested")[0].args;
      expect([...args.selected]).to.deep.equal([stack.oracles[4].address]);
    });
  });

  describe("default rule", () => {
    it("settles the default at the last consensus clamped into [L, U]", async () => {
      // Round 1 sets [L, U] around 130. A forced second round, dominated by sources reading 150,
      // moves V above U while its interval still overlaps.
      const stack = await deployEngine({ rMin: 2n * WAD });
      const { book, vault, engine, oracles } = stack;
      await vault.connect(stack.lp1).deposit({ value: eth("100") });
      const eventId = await createFlightEvent(book);
      await bindPolicy(stack, stack.alice, eventId, 133, eth("3"));
      await openFirstRound(stack, eventId);
      await playRound(stack, eventId, [
        { oracle: 0, source: 0, value: milli(128) },
        { oracle: 1, source: 1, value: milli(130) },
        { oracle: 2, source: 2, value: milli(131) },
      ]);
      await engine.forceNextRound(
        eventId,
        [3, 4, 5, 6].map((i) => oracles[i].address),
      );
      await playRound(stack, eventId, [
        { oracle: 3, source: 3, value: milli(150) },
        { oracle: 4, source: 4, value: milli(150) },
        { oracle: 5, source: 5, value: milli(150) },
        { oracle: 6, source: 1, value: milli(150) },
      ]);
      const st = await engine.eventState(eventId);
      expect(st.status).to.equal(Status.DEFAULT_PENDING);
      expect(st.vLast).to.be.gt(st.upperBound); // the clamp matters in this scenario
      await time.increaseTo(Number(st.challengeDeadline));
      await expect(engine.applyDefault(eventId))
        .to.emit(engine, "DefaultApplied")
        .withArgs(eventId, st.upperBound)
        .and.to.emit(engine, "EventFinalized")
        .withArgs(eventId, st.upperBound);
      expect(await engine.held(eventId)).to.equal(0n);
    });
  });

  describe("learning cannot block settlement", () => {
    async function finalReady() {
      const stack = await build([1, 2, 3].map(prim), [
        { bucket: 60, payout: eth("1") },
        { bucket: 250, payout: eth("1") },
      ]);
      const { engine, oracles, eventId } = stack;
      // Play the round by hand up to the point of finalizing.
      const receiptPromise = async (gasLimit?: number) => {
        const st = await engine.eventState(eventId);
        if ((await time.latest()) < Number(st.revealDeadline)) {
          await time.increaseTo(Number(st.revealDeadline));
        }
        return engine.finalizeRound(eventId, gasLimit ? { gasLimit } : {});
      };
      // Commit and reveal through the helper's round player, but stop before finalizing.
      const { signReport, commitHash, SALT } = await import("./helpers/engine");
      const st = await engine.eventState(eventId);
      const signed = [];
      for (let i = 0; i < 3; i++) {
        const r = await signReport(stack, stack.sourceWallets[i], eventId, milli(128 + i));
        await engine
          .connect(oracles[i])
          .commit(eventId, 1, commitHash(r, SALT, oracles[i].address));
        signed.push(r);
      }
      await time.increaseTo(Number(st.commitDeadline));
      for (let i = 0; i < 3; i++) {
        const r = signed[i];
        await engine
          .connect(oracles[i])
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
      return { ...stack, finalize: receiptPromise };
    }

    it("still settles and reports the skip if the learning update reverts", async () => {
      const ctx = await finalReady();
      const { registry, learning, engine, eventId, vault } = ctx;
      // Break learning: the module loses its right to write reputation.
      await registry.revokeRole(await registry.ENGINE_ROLE(), await learning.getAddress());
      await expect(ctx.finalize()).to.emit(engine, "LearningSkipped").withArgs(eventId);
      expect((await engine.eventState(eventId)).status).to.equal(Status.FINAL);
      expect(await vault.claimable()).to.equal(eth("1"));
      expect(await vault.locked()).to.equal(0n);
    });

    it("refuses to finalize with too little gas for the learning update", async () => {
      const ctx = await finalReady();
      await expect(ctx.finalize(2_000_000)).to.be.revertedWithCustomError(
        ctx.engine,
        "InsufficientGasForLearning",
      );
      await expect(ctx.finalize()).to.emit(ctx.engine, "EventFinalized");
    });
  });

  describe("registry guards", () => {
    it("rejects a zero dependence prior", async () => {
      const { registry } = await deployEngine();
      await expect(
        registry.setCategory(FLIGHT_DELAY, { ...P, rho0: 0n }),
      ).to.be.revertedWithCustomError(registry, "InvalidParams");
    });

    it("leaves oracles on inactive sources out of the recruitment view", async () => {
      const { registry, oracles } = await deployEngine({}, { oracles: [prim(1), cand(2)] });
      await registry.setSourceActive(2, false);
      const [list] = await registry.activeOracleInfo(FLIGHT_DELAY);
      expect([...list]).to.deep.equal([oracles[0].address]);
      void ethers;
    });
  });
});
