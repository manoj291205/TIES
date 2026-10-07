import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  aggregate,
  bruteForceSettlement,
  Fenwick,
  FLIGHT_DELAY_PARAMS as P,
  nextCursors,
  roundInterval,
  settledAmounts,
  WAD,
} from "../packages/ties-math/src";
import { createFlightEvent, eth, makeRng, RAIN_24H } from "./helpers/deploy";
import {
  bindPolicy,
  commitHash,
  deployEngine,
  milli,
  openFirstRound,
  parseLog,
  playRound,
  SALT,
  signReport,
  Stack,
} from "./helpers/engine";

const Status = { NONE: 0, COMMIT: 1, REVEAL: 2, DEFAULT_PENDING: 3, DISPUTED: 4, FINAL: 5 };
const Outcome = { INSUFFICIENT: 0, VALID: 1, DISPUTED: 2 };

/**
 * No oracle can ever be recruited (reputation threshold above any reputation), so these tests
 * exercise the default, challenge and dispute paths on their own.
 */
const NO_RECRUIT = { rMin: 2n * WAD };

/** Three independent flight sources agreeing around 130 min. */
const HONEST = [
  { oracle: 0, source: 0, value: milli(128) },
  { oracle: 1, source: 1, value: milli(130) },
  { oracle: 2, source: 2, value: milli(131) },
];

describe("SettlementEngine", () => {
  async function scenario() {
    const stack = await deployEngine(NO_RECRUIT);
    await stack.vault.connect(stack.lp1).deposit({ value: eth("100") });
    const eventId = await createFlightEvent(stack.book);
    const policies = [
      { holder: stack.alice, bucket: 60, payout: eth("1") },
      { holder: stack.alice, bucket: 125, payout: eth("2") },
      { holder: stack.bob, bucket: 130, payout: eth("1") },
      { holder: stack.bob, bucket: 200, payout: eth("3") },
    ];
    for (const p of policies) await bindPolicy(stack, p.holder, eventId, p.bucket, p.payout);
    await openFirstRound(stack, eventId);
    return { ...stack, eventId, policies };
  }

  async function conserved(stack: Stack) {
    const balance = await ethers.provider.getBalance(await stack.vault.getAddress());
    const free = await stack.vault.freeLiquidity();
    expect(free + (await stack.vault.locked()) + (await stack.vault.claimable())).to.equal(balance);
  }

  /** Mirrors the on-chain computation of a round in ties-math. */
  function expectedRound(
    values: bigint[],
    sources: number[],
    round: number,
    previous?: { lo: bigint; hi: bigint },
  ) {
    const n = values.length;
    const rho = values.map((_, i) =>
      values.map((_, j) => (i === j || sources[i] === sources[j] ? WAD : P.rho0)),
    );
    const rep = values.map(() => (WAD * 4n) / 5n);
    const agg = aggregate({
      x: values,
      rep,
      rho,
      s: P.s,
      sigmaFloor: P.sigmaFloor,
      delta: P.delta,
      dCut: P.dCut,
    });
    const iv = roundInterval(agg.consensus, agg.sigma, P.zByRound[round - 1]);
    const lo = previous && previous.lo > iv.lo ? previous.lo : iv.lo;
    const hi = previous && previous.hi < iv.hi ? previous.hi : iv.hi;
    return { agg, lo, hi, n };
  }

  describe("round 1 with independent sources", () => {
    it("settles by range and matches the TypeScript reference", async () => {
      const stack = await scenario();
      const { engine, eventId, policies, vault } = stack;
      const receipt = await (await playRound(stack, eventId, HONEST)).wait();
      const ev = parseLog(stack, receipt, "RoundFinalized").args;

      const exp = expectedRound(
        HONEST.map((h) => h.value),
        [0, 1, 2],
        1,
      );
      expect(ev.status).to.equal(Outcome.VALID);
      expect(ev.V).to.equal(exp.agg.consensus);
      expect(ev.sigma).to.equal(exp.agg.sigma);
      expect(ev.nEff).to.equal(exp.agg.nEff);
      expect(ev.L).to.equal(exp.lo);
      expect(ev.U).to.equal(exp.hi);
      expect(exp.agg.nEff).to.be.gte(P.nMin);

      const tree = new Fenwick(721);
      for (const p of policies) tree.add(p.bucket, p.payout);
      const old = { pay: -1, noPay: 721 };
      const next = nextCursors(old, 721, P.bucketWidth, exp.lo, exp.hi);
      const amounts = settledAmounts(tree, old, next);
      expect(ev.payCursor).to.equal(BigInt(next.pay));
      expect(ev.noPayCursor).to.equal(BigInt(next.noPay));
      expect(ev.newPay).to.equal(amounts.newPay);
      expect(ev.newNoPay).to.equal(amounts.newNoPay);
      expect(ev.held).to.equal(eth("7") - amounts.newPay - amounts.newNoPay);

      // The 60-minute policy is settled as paying and the 200-minute one as not paying.
      expect(amounts.newPay).to.equal(eth("1"));
      expect(amounts.newNoPay).to.equal(eth("3"));
      expect(await engine.payCursor(eventId)).to.equal(BigInt(next.pay));
      expect(await vault.claimable()).to.equal(eth("1"));
      expect(await vault.locked()).to.equal(eth("3"));
      expect((await engine.eventState(eventId)).status).to.equal(Status.DEFAULT_PENDING);
      await conserved(stack);
    });

    it("lets a policyholder claim once settled and not before", async () => {
      const stack = await scenario();
      const { book, engine, eventId, alice, bob } = stack;
      await expect(book.connect(alice).claim(1)).to.be.revertedWithCustomError(
        book,
        "NotSettledPaying",
      );
      await playRound(stack, eventId, HONEST);
      const before = await ethers.provider.getBalance(alice.address);
      const tx = await book.connect(alice).claim(1);
      const receipt = await tx.wait();
      const after = await ethers.provider.getBalance(alice.address);
      expect(after - before + receipt!.gasUsed * receipt!.gasPrice).to.equal(eth("1"));
      // Held (125, 130) and settled-not-paying (200) policies cannot claim.
      await expect(book.connect(alice).claim(2)).to.be.revertedWithCustomError(
        book,
        "NotSettledPaying",
      );
      await expect(book.connect(bob).claim(4)).to.be.revertedWithCustomError(
        book,
        "NotSettledPaying",
      );
      expect(await engine.held(eventId)).to.equal(eth("3"));
      await conserved(stack);
    });
  });

  describe("single-source evidence (P1)", () => {
    it("moves no collateral however many keys read the same source", async () => {
      const stack = await scenario();
      const { engine, eventId, vault } = stack;
      const lockedBefore = await vault.locked();
      // Oracles 1, 6 and 7 all read source 2.
      const reports = [
        { oracle: 1, source: 1, value: milli(130) },
        { oracle: 6, source: 1, value: milli(130) },
        { oracle: 7, source: 1, value: milli(130) },
      ];
      const receipt = await (await playRound(stack, eventId, reports)).wait();
      const ev = parseLog(stack, receipt, "RoundFinalized").args;
      expect(ev.status).to.equal(Outcome.INSUFFICIENT);
      expect(ev.nEff).to.equal(WAD);
      expect(ev.newPay).to.equal(0n);
      expect(ev.newNoPay).to.equal(0n);
      expect(await vault.locked()).to.equal(lockedBefore);
      expect(await vault.claimable()).to.equal(0n);
      expect(await engine.payCursor(eventId)).to.equal(-1n);
      expect((await engine.eventState(eventId)).hasInterval).to.equal(false);
      await conserved(stack);
    });

    it("moves nothing when no report is revealed", async () => {
      const stack = await scenario();
      const { engine, eventId, oracles, sourceWallets } = stack;
      // One oracle commits but never reveals.
      const r = await signReport(stack, sourceWallets[0], eventId, milli(130));
      await engine.connect(oracles[0]).commit(eventId, 1, commitHash(r, SALT, oracles[0].address));
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.revealDeadline));
      const receipt = await (await engine.finalizeRound(eventId)).wait();
      const ev = parseLog(stack, receipt, "RoundFinalized").args;
      expect(ev.status).to.equal(Outcome.INSUFFICIENT);
      expect(await engine.reportCount(eventId)).to.equal(0n);
      expect(await stack.vault.claimable()).to.equal(0n);
    });
  });

  describe("forged reports (P6)", () => {
    it("rejects a tampered value even when the oracle committed to it", async () => {
      const stack = await scenario();
      const { engine, eventId, oracles, sourceWallets, verifier } = stack;
      const signed = await signReport(stack, sourceWallets[0], eventId, milli(130));
      const tampered = { ...signed, value: milli(250) }; // changed after signing
      await engine
        .connect(oracles[0])
        .commit(eventId, 1, commitHash(tampered, SALT, oracles[0].address));
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.commitDeadline));
      await expect(
        engine
          .connect(oracles[0])
          .reveal(
            eventId,
            1,
            tampered.value,
            tampered.ts,
            tampered.toolHash,
            tampered.argsHash,
            tampered.responseHash,
            tampered.sourceSig,
            SALT,
          ),
      ).to.be.revertedWithCustomError(verifier, "UnknownSigner");
      expect(await engine.reportCount(eventId)).to.equal(0n);
    });

    it("rejects a report signed by an unregistered key", async () => {
      const stack = await scenario();
      const { engine, eventId, oracles, verifier } = stack;
      const forged = await signReport(stack, ethers.Wallet.createRandom(), eventId, milli(130));
      await engine
        .connect(oracles[0])
        .commit(eventId, 1, commitHash(forged, SALT, oracles[0].address));
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.commitDeadline));
      await expect(
        engine
          .connect(oracles[0])
          .reveal(
            eventId,
            1,
            forged.value,
            forged.ts,
            forged.toolHash,
            forged.argsHash,
            forged.responseHash,
            forged.sourceSig,
            SALT,
          ),
      ).to.be.revertedWithCustomError(verifier, "UnknownSigner");
    });
  });

  describe("commit and reveal protocol", () => {
    async function committed() {
      const stack = await scenario();
      const { engine, eventId, oracles, sourceWallets } = stack;
      const r = await signReport(stack, sourceWallets[0], eventId, milli(130));
      const hash = commitHash(r, SALT, oracles[0].address);
      return {
        ...stack,
        r,
        hash,
        reveal: (o = oracles[0], salt = SALT, round = 1) =>
          engine
            .connect(o)
            .reveal(
              eventId,
              round,
              r.value,
              r.ts,
              r.toolHash,
              r.argsHash,
              r.responseHash,
              r.sourceSig,
              salt,
            ),
      };
    }

    it("only accepts one commit per committee member, inside the window", async () => {
      const { engine, eventId, oracles, hash, alice } = await committed();
      await expect(engine.connect(alice).commit(eventId, 1, hash)).to.be.revertedWithCustomError(
        engine,
        "NotInCommittee",
      );
      await expect(
        engine.connect(oracles[0]).commit(eventId, 1, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(engine, "EmptyCommit");
      await expect(
        engine.connect(oracles[0]).commit(eventId, 2, hash),
      ).to.be.revertedWithCustomError(engine, "WrongRound");
      await expect(engine.connect(oracles[0]).commit(eventId, 1, hash))
        .to.emit(engine, "ReportCommitted")
        .withArgs(eventId, 1, oracles[0].address);
      await expect(
        engine.connect(oracles[0]).commit(eventId, 1, hash),
      ).to.be.revertedWithCustomError(engine, "AlreadyCommitted");
      expect(await engine.commitOf(eventId, 1, oracles[0].address)).to.equal(hash);
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.commitDeadline));
      await expect(engine.connect(oracles[1]).commit(eventId, 1, hash)).to.be.reverted;
    });

    it("rejects commits after the commit window", async () => {
      const { engine, eventId, oracles, hash } = await committed();
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.commitDeadline));
      await expect(
        engine.connect(oracles[0]).commit(eventId, 1, hash),
      ).to.be.revertedWithCustomError(engine, "CommitWindowClosed");
    });

    it("enforces the reveal window and the commit binding", async () => {
      const { engine, eventId, oracles, hash, reveal } = await committed();
      await expect(reveal()).to.be.revertedWithCustomError(engine, "CommitWindowOpen");
      await engine.connect(oracles[0]).commit(eventId, 1, hash);
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.commitDeadline));
      await expect(reveal(oracles[1])).to.be.revertedWithCustomError(engine, "NoCommit");
      await expect(reveal(oracles[0], ethers.id("other"))).to.be.revertedWithCustomError(
        engine,
        "CommitMismatch",
      );
      await expect(reveal(oracles[0], SALT, 2)).to.be.revertedWithCustomError(engine, "WrongRound");
      await expect(reveal())
        .to.emit(engine, "ReportRevealed")
        .withArgs(eventId, 1, oracles[0].address, 1, milli(130));
      expect((await engine.eventState(eventId)).status).to.equal(Status.REVEAL);
      expect(await engine.reportCount(eventId)).to.equal(1n);
      const report = await engine.reportAt(eventId, 0);
      expect([report.oracle, report.sourceId, report.round, report.value]).to.deep.equal([
        oracles[0].address,
        1n,
        1n,
        milli(130),
      ]);
    });

    it("rejects reveals after the reveal deadline", async () => {
      const { engine, eventId, oracles, hash, reveal } = await committed();
      await engine.connect(oracles[0]).commit(eventId, 1, hash);
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.revealDeadline));
      await expect(reveal()).to.be.revertedWithCustomError(engine, "RevealWindowClosed");
    });

    it("lets an oracle report only once per event across rounds", async () => {
      const stack = await committed();
      const { engine, eventId, oracles, hash, reveal } = stack;
      await engine.connect(oracles[0]).commit(eventId, 1, hash);
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.commitDeadline));
      await reveal();
      await time.increaseTo(Number(st.revealDeadline));
      await engine.finalizeRound(eventId);
      await engine.forceNextRound(eventId, [oracles[0].address]);
      await engine.connect(oracles[0]).commit(eventId, 2, hash);
      const st2 = await engine.eventState(eventId);
      await time.increaseTo(Number(st2.commitDeadline));
      await expect(reveal(oracles[0], SALT, 2)).to.be.revertedWithCustomError(
        engine,
        "AlreadyReported",
      );
    });

    it("caps an event at 16 reports", async () => {
      const stack = await scenario();
      const { engine, eventId, registry, sourceWallets } = stack;
      await playRound(stack, eventId, [
        ...HONEST,
        { oracle: 3, source: 3, value: milli(130) },
        { oracle: 4, source: 4, value: milli(130) },
        { oracle: 5, source: 5, value: milli(130) },
        { oracle: 6, source: 1, value: milli(130) },
        { oracle: 7, source: 1, value: milli(130) },
      ]);
      // Nine fresh oracle keys join a second round; the ninth would be report number 17.
      const fresh = [];
      for (let i = 0; i < 9; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        await ethers.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
        await registry.registerOracle(w.address, 0, (i % 6) + 1, false);
        fresh.push(w);
      }
      await engine.forceNextRound(
        eventId,
        fresh.map((w) => w.address),
      );
      const st = await engine.eventState(eventId);
      const signed = [];
      for (let i = 0; i < 9; i++) {
        const r = await signReport(stack, sourceWallets[i % 6], eventId, milli(130));
        await engine.connect(fresh[i]).commit(eventId, 2, commitHash(r, SALT, fresh[i].address));
        signed.push(r);
      }
      await time.increaseTo(Number(st.commitDeadline));
      const reveal = (i: number) =>
        engine
          .connect(fresh[i])
          .reveal(
            eventId,
            2,
            signed[i].value,
            signed[i].ts,
            signed[i].toolHash,
            signed[i].argsHash,
            signed[i].responseHash,
            signed[i].sourceSig,
            SALT,
          );
      for (let i = 0; i < 8; i++) await reveal(i);
      expect(await engine.reportCount(eventId)).to.equal(16n);
      await expect(reveal(8)).to.be.revertedWithCustomError(engine, "TooManyReports");
    });
  });

  describe("round lifecycle", () => {
    it("opens rounds only after the observation window, once", async () => {
      const stack = await deployEngine(NO_RECRUIT);
      await stack.vault.connect(stack.lp1).deposit({ value: eth("10") });
      const eventId = await createFlightEvent(stack.book);
      await expect(stack.engine.openRound(eventId)).to.be.revertedWithCustomError(
        stack.engine,
        "ObservationNotEnded",
      );
      await expect(stack.engine.finalizeRound(eventId)).to.be.revertedWithCustomError(
        stack.engine,
        "WrongStatus",
      );
      await openFirstRound(stack, eventId);
      await expect(stack.engine.openRound(eventId)).to.be.revertedWithCustomError(
        stack.engine,
        "WrongStatus",
      );
      const committee = await stack.engine.committeeOf(eventId, 1);
      expect(committee).to.have.length(8);
    });

    it("needs a primary oracle to open a round", async () => {
      const stack = await deployEngine(NO_RECRUIT);
      const now = await time.latest();
      await stack.book.createEvent(
        RAIN_24H,
        "Chennai",
        "13.08,80.27|2026-09-01",
        now + 100,
        now + 200,
      );
      await time.increaseTo(now + 200);
      await expect(stack.engine.openRound(1)).to.be.revertedWithCustomError(
        stack.engine,
        "NoCommittee",
      );
    });

    it("cannot finalize before the reveal deadline", async () => {
      const stack = await scenario();
      await expect(stack.engine.finalizeRound(stack.eventId)).to.be.revertedWithCustomError(
        stack.engine,
        "RevealWindowOpen",
      );
    });

    it("finalizes a fully settled event and reports no held collateral", async () => {
      const stack = await deployEngine(NO_RECRUIT);
      await stack.vault.connect(stack.lp1).deposit({ value: eth("100") });
      const eventId = await createFlightEvent(stack.book);
      await bindPolicy(stack, stack.alice, eventId, 20, eth("1"));
      await bindPolicy(stack, stack.bob, eventId, 300, eth("2"));
      await openFirstRound(stack, eventId);
      const receipt = await (await playRound(stack, eventId, HONEST)).wait();
      expect(parseLog(stack, receipt, "RoundFinalized").args.held).to.equal(0n);
      expect((await stack.engine.eventState(eventId)).status).to.equal(Status.FINAL);
      expect(await stack.vault.claimable()).to.equal(eth("1"));
      expect(await stack.vault.locked()).to.equal(0n);
      await conserved(stack);
    });
  });

  describe("monotone settlement and disputes (P2)", () => {
    it("only moves cursors forward across rounds", async () => {
      const stack = await scenario();
      const { engine, eventId, oracles } = stack;
      await playRound(stack, eventId, HONEST);
      const first = await engine.eventState(eventId);
      const pay1 = await engine.payCursor(eventId);
      const noPay1 = await engine.noPayCursor(eventId);

      await engine.forceNextRound(eventId, [oracles[3].address, oracles[4].address]);
      const receipt = await (
        await playRound(stack, eventId, [
          { oracle: 3, source: 3, value: milli(129) },
          { oracle: 4, source: 4, value: milli(130) },
        ])
      ).wait();
      const ev = parseLog(stack, receipt, "RoundFinalized").args;
      expect(ev.status).to.equal(Outcome.VALID);
      const second = await engine.eventState(eventId);
      expect(second.lowerBound).to.be.gte(first.lowerBound);
      expect(second.upperBound).to.be.lte(first.upperBound);
      expect(await engine.payCursor(eventId)).to.be.gte(pay1);
      expect(await engine.noPayCursor(eventId)).to.be.lte(noPay1);
      expect(second.settledPay).to.be.gte(first.settledPay);
      await conserved(stack);
    });

    it("disputes inconsistent evidence, keeps held money locked and settles on resolution", async () => {
      const stack = await scenario();
      const { engine, eventId, oracles, vault, admin } = stack;
      await playRound(stack, eventId, HONEST);
      const before = await engine.eventState(eventId);
      const lockedBefore = await vault.locked();

      await engine.forceNextRound(
        eventId,
        [3, 4, 5, 6, 7].map((i) => oracles[i].address),
      );
      const receipt = await (
        await playRound(stack, eventId, [
          { oracle: 3, source: 3, value: milli(300) },
          { oracle: 4, source: 4, value: milli(300) },
          { oracle: 5, source: 5, value: milli(300) },
          { oracle: 6, source: 1, value: milli(300) },
          { oracle: 7, source: 1, value: milli(300) },
        ])
      ).wait();
      const ev = parseLog(stack, receipt, "RoundFinalized").args;
      expect(ev.status).to.equal(Outcome.DISPUTED);
      expect(ev.newPay).to.equal(0n);
      expect(ev.newNoPay).to.equal(0n);
      const after = await engine.eventState(eventId);
      expect(after.status).to.equal(Status.DISPUTED);
      expect(after.lowerBound).to.equal(before.lowerBound);
      expect(after.upperBound).to.equal(before.upperBound);
      expect(await vault.locked()).to.equal(lockedBefore);
      expect(receipt!.logs.length).to.be.gt(0);

      await expect(
        engine.connect(stack.alice).resolveDispute(eventId, milli(130)),
      ).to.be.revertedWithCustomError(engine, "AccessControlUnauthorizedAccount");
      await expect(engine.connect(admin).resolveDispute(eventId, milli(130)))
        .to.emit(engine, "DisputeResolved")
        .withArgs(eventId, milli(130))
        .and.to.emit(engine, "EventFinalized");
      expect((await engine.eventState(eventId)).status).to.equal(Status.FINAL);
      // Policies at 60, 125 and 130 pay (threshold <= 130); the 200 policy does not.
      expect(await vault.claimable()).to.equal(eth("4"));
      expect(await vault.locked()).to.equal(0n);
      expect(await engine.held(eventId)).to.equal(0n);
      await stack.book.connect(stack.bob).claim(3);
      await expect(stack.book.connect(stack.bob).claim(4)).to.be.revertedWithCustomError(
        stack.book,
        "NotSettledPaying",
      );
      await conserved(stack);
    });

    it("never reverses settled buckets when a dispute is resolved far below them", async () => {
      const stack = await scenario();
      const { engine, eventId, vault, admin } = stack;
      await playRound(stack, eventId, HONEST);
      await engine.connect(stack.rest[10]).challenge(eventId, { value: eth("0.05") });
      // The 60 policy is already paying; a final value of 10 must not take that back.
      await engine.connect(admin).resolveDispute(eventId, milli(10));
      expect(await engine.payCursor(eventId)).to.be.gte(60n);
      expect(await vault.claimable()).to.equal(eth("1"));
      await conserved(stack);
    });
  });

  describe("defaults and challenges", () => {
    it("applies the default at the last consensus after the challenge period", async () => {
      const stack = await scenario();
      const { engine, eventId, vault, book, bob } = stack;
      await playRound(stack, eventId, HONEST);
      await expect(engine.applyDefault(eventId)).to.be.revertedWithCustomError(
        engine,
        "ChallengeWindowOpen",
      );
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.challengeDeadline));
      const vLast = st.vLast;
      await expect(engine.applyDefault(eventId))
        .to.emit(engine, "DefaultApplied")
        .withArgs(eventId, vLast);
      expect((await engine.eventState(eventId)).status).to.equal(Status.FINAL);
      // Policies at 60 and 125 (<= V) pay, 130 and 200 do not, assuming V is below 130.
      expect(vLast).to.be.lt(milli(130));
      expect(vLast).to.be.gte(milli(125));
      expect(await vault.claimable()).to.equal(eth("3"));
      expect(await vault.locked()).to.equal(0n);
      await expect(book.connect(bob).claim(3)).to.be.revertedWithCustomError(
        book,
        "NotSettledPaying",
      );
      await conserved(stack);
    });

    it("sends the bond back when the challenge is upheld and to the vault when it is not", async () => {
      for (const upheld of [true, false]) {
        const stack = await scenario();
        const { engine, eventId, vault, admin } = stack;
        const challenger = stack.rest[10];
        await playRound(stack, eventId, HONEST);
        await expect(
          engine.connect(challenger).challenge(eventId, { value: eth("0.01") }),
        ).to.be.revertedWithCustomError(engine, "WrongBond");
        await expect(engine.connect(challenger).challenge(eventId, { value: eth("0.05") }))
          .to.emit(engine, "EventChallenged")
          .withArgs(eventId, challenger.address, eth("0.05"));
        expect((await engine.eventState(eventId)).status).to.equal(Status.DISPUTED);
        const vLast = (await engine.eventState(eventId)).vLast;
        const finalValue = upheld ? milli(300) : vLast + milli(1);
        const challengerBefore = await ethers.provider.getBalance(challenger.address);
        const vaultBefore = await ethers.provider.getBalance(await vault.getAddress());
        await engine.connect(admin).resolveDispute(eventId, finalValue);
        const challengerAfter = await ethers.provider.getBalance(challenger.address);
        const vaultAfter = await ethers.provider.getBalance(await vault.getAddress());
        if (upheld) {
          expect(challengerAfter - challengerBefore).to.equal(eth("0.05"));
          expect(vaultAfter).to.equal(vaultBefore);
        } else {
          expect(challengerAfter).to.equal(challengerBefore);
          expect(vaultAfter - vaultBefore).to.equal(eth("0.05"));
        }
        expect(await ethers.provider.getBalance(await engine.getAddress())).to.equal(0n);
      }
    });

    it("sends the bond to the vault when the challenger cannot receive ETH", async () => {
      const stack = await scenario();
      const { engine, eventId, vault, admin } = stack;
      await playRound(stack, eventId, HONEST);
      // A contract without a receive function (the batcher has one, the book does not) challenges.
      const book = await stack.book.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [book]);
      await ethers.provider.send("hardhat_setBalance", [book, "0x56BC75E2D63100000"]);
      const signer = await ethers.getSigner(book);
      await engine.connect(signer).challenge(eventId, { value: eth("0.05") });
      const vaultBefore = await ethers.provider.getBalance(await vault.getAddress());
      await engine.connect(admin).resolveDispute(eventId, milli(300));
      expect((await ethers.provider.getBalance(await vault.getAddress())) - vaultBefore).to.equal(
        eth("0.05"),
      );
    });

    it("rejects challenges and defaults in the wrong state or time", async () => {
      const stack = await scenario();
      const { engine, eventId } = stack;
      await expect(engine.challenge(eventId, { value: eth("0.05") })).to.be.revertedWithCustomError(
        engine,
        "WrongStatus",
      );
      await expect(engine.applyDefault(eventId)).to.be.revertedWithCustomError(
        engine,
        "WrongStatus",
      );
      await expect(engine.resolveDispute(eventId, milli(1))).to.be.revertedWithCustomError(
        engine,
        "WrongStatus",
      );
      await playRound(stack, eventId, HONEST);
      const st = await engine.eventState(eventId);
      await time.increaseTo(Number(st.challengeDeadline));
      await expect(engine.challenge(eventId, { value: eth("0.05") })).to.be.revertedWithCustomError(
        engine,
        "ChallengeWindowClosed",
      );
    });
  });

  describe("range settlement equals brute force (P3)", () => {
    it("settles the same money as evaluating every policy", async () => {
      const stack = await deployEngine(NO_RECRUIT);
      const { engine, vault, book, alice, bob } = stack;
      await vault.connect(stack.lp1).deposit({ value: eth("200") });
      const eventId = await createFlightEvent(book, 5000, 6000);
      const rnd = makeRng(4242);
      const policies: { bucket: number; payout: bigint }[] = [];
      for (let i = 0; i < 30; i++) {
        const bucket = 80 + rnd(100);
        const payout = eth("0.01") * BigInt(1 + rnd(5));
        try {
          await bindPolicy(stack, i % 2 ? alice : bob, eventId, bucket, payout);
          policies.push({ bucket, payout });
        } catch {
          // Capacity rejections are legal and simply not part of the policy set.
        }
      }
      expect(policies.length).to.be.gt(15);
      await openFirstRound(stack, eventId);
      const receipt = await (await playRound(stack, eventId, HONEST)).wait();
      const ev = parseLog(stack, receipt, "RoundFinalized").args;
      const brute = bruteForceSettlement(policies, 1000n, ev.L, ev.U);
      expect(ev.newPay).to.equal(brute.pay);
      expect(ev.newNoPay).to.equal(brute.noPay);
      expect(ev.held).to.equal(brute.held);

      // A second, narrower round: cumulative settlement still equals brute force.
      await engine.forceNextRound(eventId, [stack.oracles[3].address, stack.oracles[4].address]);
      await playRound(stack, eventId, [
        { oracle: 3, source: 3, value: milli(129) },
        { oracle: 4, source: 4, value: milli(130) },
      ]);
      const state = await engine.eventState(eventId);
      const brute2 = bruteForceSettlement(policies, 1000n, state.lowerBound, state.upperBound);
      expect(state.settledPay).to.equal(brute2.pay);
      expect(state.settledNoPay).to.equal(brute2.noPay);
      expect(await engine.held(eventId)).to.equal(brute2.held);
      await conserved(stack);
    });
  });

  describe("settlement cost does not grow with the number of policies (P4)", () => {
    it("finalizes 10 and 1000 policies for the same gas", async function () {
      this.timeout(900_000);
      const stack = await deployEngine(NO_RECRUIT);
      const { book, vault, engine } = stack;
      await vault.connect(stack.lp1).deposit({ value: eth("400") });
      const batcher = await (await ethers.getContractFactory("BindBatcher")).deploy();
      // A warm-up event makes the vault's counters non-zero, so both measured events pay the same
      // storage costs (the very first settlement would otherwise pay to initialise them).
      const warm = await createFlightEvent(book, 100_000, 200_000);
      const small = await createFlightEvent(book, 100_000, 200_000);
      const large = await createFlightEvent(book, 100_000, 200_000);
      const rnd = makeRng(777);
      const payout = eth("0.005");

      async function fill(eventId: bigint, count: number) {
        // A few anchor policies on both sides of the interval, the rest spread over the axis.
        const buckets = [20, 40, 130, 220, 300];
        while (buckets.length < count) buckets.push(rnd(721));
        const chunk = 40;
        for (let i = 0; i < count; i += chunk) {
          const slice = buckets.slice(i, i + chunk);
          await batcher.bindMany(await book.getAddress(), eventId, slice, payout, {
            value: eth("40"),
          });
        }
      }
      await fill(warm, 10);
      await fill(small, 10);
      await fill(large, 1000);
      expect(await book.eventLocked(large)).to.equal(payout * 1000n);

      const gasFor = async (eventId: bigint) => {
        await openFirstRound(stack, eventId);
        const receipt = await (await playRound(stack, eventId, HONEST)).wait();
        const ev = parseLog(stack, receipt, "RoundFinalized").args;
        expect(ev.newPay).to.be.gt(0n);
        expect(ev.newNoPay).to.be.gt(0n);
        return receipt!.gasUsed;
      };
      await gasFor(warm);
      const gasSmall = await gasFor(small);
      const gasLarge = await gasFor(large);
      const diff = gasLarge > gasSmall ? gasLarge - gasSmall : gasSmall - gasLarge;
      console.log(`      finalizeRound gas: n=10 -> ${gasSmall}, n=1000 -> ${gasLarge}`);
      expect(Number(diff) / Number(gasSmall)).to.be.lt(0.03);
      void engine;
    });
  });
});
