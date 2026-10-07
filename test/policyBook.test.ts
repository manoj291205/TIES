import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  attainableWindow,
  Fenwick,
  quote as refQuote,
  FLIGHT_DELAY_PARAMS,
} from "../packages/ties-math/src";
import {
  createFlightEvent,
  deployCore,
  eth,
  FLIGHT_DELAY,
  makeRng,
  RAIN_24H,
} from "./helpers/deploy";

describe("PolicyBook", () => {
  async function setup(lpDeposit = "100") {
    const ctx = await deployCore();
    await ctx.vault.connect(ctx.lp1).deposit({ value: eth(lpDeposit) });
    const eventId = await createFlightEvent(ctx.book);
    return { ...ctx, eventId };
  }

  describe("events", () => {
    it("creates an event and snapshots the parameter version", async () => {
      const { book, registry } = await deployCore();
      const eventId = await createFlightEvent(book);
      const e = await book.eventData(eventId);
      expect(e.exists).to.equal(true);
      expect(e.category).to.equal(FLIGHT_DELAY);
      expect(e.version).to.equal(0n);
      expect(e.label).to.equal("AI 101 DEL-BOM 2026-10-12");
      expect(e.observationKey).to.equal("AI101|2026-10-12");
      // A later parameter change creates a new version; the existing event keeps version 0.
      await registry.setCategory(FLIGHT_DELAY, { ...FLIGHT_DELAY_PARAMS, margin: 0n });
      expect((await book.eventData(eventId)).version).to.equal(0n);
      const second = await createFlightEvent(book);
      expect((await book.eventData(second)).version).to.equal(1n);
    });

    it("emits EventCreated and validates inputs", async () => {
      const { book, alice } = await deployCore();
      const now = await time.latest();
      await expect(book.createEvent(FLIGHT_DELAY, "L", "K", now + 100, now + 200))
        .to.emit(book, "EventCreated")
        .withArgs(1, FLIGHT_DELAY, "L", now + 100, now + 200);
      await expect(
        book.createEvent(FLIGHT_DELAY, "L", "K", now, now + 200),
      ).to.be.revertedWithCustomError(book, "InvalidEventTimes");
      await expect(
        book.createEvent(FLIGHT_DELAY, "L", "K", now + 500, now + 400),
      ).to.be.revertedWithCustomError(book, "InvalidEventTimes");
      await expect(
        book.createEvent(9, "L", "K", now + 500, now + 600),
      ).to.be.revertedWithCustomError(
        await ethers.getContractAt("TIESRegistry", await book.registry()),
        "UnknownCategory",
      );
      await expect(
        book.connect(alice).createEvent(FLIGHT_DELAY, "L", "K", now + 500, now + 600),
      ).to.be.revertedWithCustomError(book, "AccessControlUnauthorizedAccount");
    });

    it("reports unknown events", async () => {
      const { book } = await deployCore();
      await expect(book.eventData(1)).to.be.revertedWithCustomError(book, "UnknownEvent");
      await expect(book.quote(1, 0, 1)).to.be.revertedWithCustomError(book, "UnknownEvent");
    });
  });

  describe("pricing", () => {
    it("matches the TypeScript reference for many buckets and payouts", async () => {
      const { book, eventId } = await setup();
      const rnd = makeRng(2024);
      for (let i = 0; i < 40; i++) {
        const bucket = BigInt(rnd(721));
        const payout = BigInt(rnd(10_000_000) + 1) * 10n ** 11n;
        expect(await book.quote(eventId, bucket, payout)).to.equal(
          refQuote(FLIGHT_DELAY_PARAMS, bucket, payout),
        );
      }
    });

    it("prices known points of the exceedance curve", async () => {
      const { book, eventId } = await setup();
      // 120 min: q = 0.09; 1 ETH * 0.09 * 1.2 + 0.002 fee = 0.110 ETH.
      expect(await book.quote(eventId, 120, eth("1"))).to.equal(eth("0.110"));
      // 0 min: q = 1.0; 1 ETH * 1.2 + 0.002 fee.
      expect(await book.quote(eventId, 0, eth("1"))).to.equal(eth("1.202"));
      // Past the end of the curve the last probability (0.002) applies.
      expect(await book.quote(eventId, 720, eth("1"))).to.equal(eth("0.0044"));
    });
  });

  describe("binding", () => {
    it("binds a policy, locks collateral, forwards the premium and refunds the excess", async () => {
      const { book, vault, alice, eventId } = await setup();
      const premium = await book.quote(eventId, 120, eth("2"));
      const vaultBefore = await ethers.provider.getBalance(await vault.getAddress());
      await expect(book.connect(alice).bind(eventId, 120, eth("2"), { value: premium + eth("1") }))
        .to.emit(book, "PolicyBound")
        .withArgs(1, eventId, alice.address, 120, eth("2"), premium);
      expect(await vault.locked()).to.equal(eth("2"));
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(
        vaultBefore + premium,
      );
      expect(await ethers.provider.getBalance(await book.getAddress())).to.equal(0n);
      expect(await book.eventLocked(eventId)).to.equal(eth("2"));
      expect(await book.rangeCollateral(eventId, 120, 120)).to.equal(eth("2"));
      expect(await book.policyCount()).to.equal(1n);
      const pol = await book.getPolicy(1);
      expect([pol.holder, pol.bucket, pol.payout, pol.premium, pol.claimed]).to.deep.equal([
        alice.address,
        120n,
        eth("2"),
        premium,
        false,
      ]);
      expect(await book.policiesOf(alice.address)).to.deep.equal([1n]);
    });

    it("keeps premiums earned by LPs in the vault (no stuck premiums)", async () => {
      const { book, vault, alice, lp1, eventId } = await setup();
      const premium = await book.quote(eventId, 120, eth("2"));
      await book.connect(alice).bind(eventId, 120, eth("2"), { value: premium });
      expect(await vault.totalAssets()).to.equal(eth("100") + premium);
      expect(await vault.maxWithdraw(lp1.address)).to.be.gt(eth("98"));
    });

    it("rejects underpayment, zero payout, bad buckets and unknown events", async () => {
      const { book, alice, eventId } = await setup();
      const premium = await book.quote(eventId, 120, eth("1"));
      await expect(
        book.connect(alice).bind(eventId, 120, eth("1"), { value: premium - 1n }),
      ).to.be.revertedWithCustomError(book, "InsufficientPremium");
      await expect(
        book.connect(alice).bind(eventId, 120, 0, { value: premium }),
      ).to.be.revertedWithCustomError(book, "ZeroPayout");
      await expect(
        book.connect(alice).bind(eventId, 721, eth("1"), { value: premium }),
      ).to.be.revertedWithCustomError(book, "BucketOutOfRange");
      await expect(
        book.connect(alice).bind(99, 120, eth("1"), { value: premium }),
      ).to.be.revertedWithCustomError(book, "UnknownEvent");
    });

    it("rejects binding at and after the cutoff", async () => {
      const { book, alice, eventId } = await setup();
      const premium = await book.quote(eventId, 120, eth("1"));
      const e = await book.eventData(eventId);
      await time.setNextBlockTimestamp(e.cutoff);
      await expect(
        book.connect(alice).bind(eventId, 120, eth("1"), { value: premium }),
      ).to.be.revertedWithCustomError(book, "CutoffPassed");
    });

    it("rejects binding when an event has no active source", async () => {
      const { book, registry, alice, eventId } = await setup();
      for (let id = 1; id <= 6; id++) await registry.setSourceActive(id, false);
      await expect(
        book.connect(alice).bind(eventId, 120, eth("1"), { value: eth("1") }),
      ).to.be.revertedWithCustomError(book, "NoActiveSources");
    });

    it("rejects a refund to a recipient that cannot receive ETH", async () => {
      const { book, eventId, mockEngine } = await setup();
      // Impersonate the mock engine (a contract without a receive function) as the holder.
      await ethers.provider.send("hardhat_impersonateAccount", [await mockEngine.getAddress()]);
      await ethers.provider.send("hardhat_setBalance", [
        await mockEngine.getAddress(),
        "0x56BC75E2D63100000",
      ]);
      const signer = await ethers.getSigner(await mockEngine.getAddress());
      const premium = await book.quote(eventId, 120, eth("1"));
      await expect(
        book.connect(signer).bind(eventId, 120, eth("1"), { value: premium + 1n }),
      ).to.be.revertedWithCustomError(book, "RefundFailed");
    });
  });

  describe("capacity", () => {
    it("computes the attainable window like the reference", async () => {
      const { book, eventId } = await setup();
      const expected = attainableWindow(6n, FLIGHT_DELAY_PARAMS);
      expect(await book.windowOf(eventId)).to.equal(expected);
      expect(expected).to.equal(5n);
    });

    it("rejects cover that overfills the window around a threshold", async () => {
      const { book, vault, alice, bob, eventId, lp2 } = await setup();
      await vault.connect(lp2).deposit({ value: eth("200") });
      // 8 ETH at 120 min, then 3 ETH at 123 min: window of +-5 buckets holds 11 > 10 ETH cap.
      await book.connect(alice).bind(eventId, 120, eth("8"), { value: eth("1.5") });
      expect(await book.capacityLeftNear(eventId, 123)).to.equal(eth("2"));
      const premium = await book.quote(eventId, 123, eth("3"));
      await expect(book.connect(bob).bind(eventId, 123, eth("3"), { value: premium }))
        .to.be.revertedWithCustomError(book, "CapacityWindowExceeded")
        .withArgs(123, eth("11"), eth("10"));
      // A threshold outside the window is fine.
      const farPremium = await book.quote(eventId, 140, eth("3"));
      await book.connect(bob).bind(eventId, 140, eth("3"), { value: farPremium });
      expect(await book.capacityLeftNear(eventId, 120)).to.equal(eth("2"));
    });

    it("suggests the nearest bucket with room", async () => {
      const { book, vault, alice, eventId, lp2 } = await setup();
      await vault.connect(lp2).deposit({ value: eth("200") });
      await book.connect(alice).bind(eventId, 120, eth("10"), { value: eth("2") });
      // A policy at 120 is full; at 126 the window (121..131) no longer contains bucket 120.
      expect(await book.nearestAvailableBucket(eventId, 120, eth("1"))).to.equal(126n);
      // Below the full window the search goes downwards.
      expect(await book.nearestAvailableBucket(eventId, 114, eth("1"))).to.equal(114n);
      // Searching from a bucket near the start of the axis only moves upwards.
      expect(await book.nearestAvailableBucket(eventId, 0, eth("1"))).to.equal(0n);
    });

    it("reverts the suggestion when nothing nearby has room", async () => {
      const { book, vault, alice, eventId, lp2 } = await setup();
      await vault.connect(lp2).deposit({ value: eth("2000") });
      // One full 10 ETH bucket every 11 buckets: every 11-wide window then holds a full bucket.
      for (let b = 33; b <= 209; b += 11) {
        await book.connect(alice).bind(eventId, b, eth("10"), { value: eth("6") });
      }
      await expect(
        book.nearestAvailableBucket(eventId, 120, eth("1")),
      ).to.be.revertedWithCustomError(book, "CapacityWindowExceeded");
    });

    it("limits an event to a share of free liquidity", async () => {
      const { book, alice, eventId } = await setup("20"); // eta 0.25 -> 5 ETH allowed
      await book.connect(alice).bind(eventId, 200, eth("4"), { value: eth("1") });
      await expect(
        book.connect(alice).bind(eventId, 400, eth("2"), { value: eth("1") }),
      ).to.be.revertedWithCustomError(book, "EventShareExceeded");
    });
  });

  describe("views", () => {
    it("returns per-bucket collateral and range sums", async () => {
      const { book, alice, bob, eventId } = await setup();
      await book.connect(alice).bind(eventId, 10, eth("1"), { value: eth("1") });
      await book.connect(bob).bind(eventId, 12, eth("2"), { value: eth("3") });
      await book.connect(bob).bind(eventId, 12, eth("0.5"), { value: eth("1") });
      const amounts = await book.bucketsInRange(eventId, 9, 13);
      expect(amounts.map(BigInt)).to.deep.equal([0n, eth("1"), 0n, eth("2.5"), 0n]);
      expect(await book.rangeCollateral(eventId, -1, 100)).to.equal(eth("3.5"));
      expect(await book.rangeCollateral(eventId, 11, 12)).to.equal(eth("2.5"));
      expect(await book.rangeCollateral(eventId, 5, 4)).to.equal(0n);
      const all = await book.bucketsInRange(eventId, 0, 720);
      expect(all.reduce((a: bigint, b: bigint) => a + b, 0n)).to.equal(eth("3.5"));
    });

    it("mirrors an off-chain Fenwick tree for random policy sets", async () => {
      const { book, vault, lp2, alice, eventId } = await setup();
      await vault.connect(lp2).deposit({ value: eth("900") });
      const ref = new Fenwick(721);
      const rnd = makeRng(5);
      for (let i = 0; i < 25; i++) {
        const bucket = rnd(721);
        const payout = eth("0.1") * BigInt(rnd(5) + 1);
        const premium = await book.quote(eventId, bucket, payout);
        const tx = book.connect(alice).bind(eventId, bucket, payout, { value: premium });
        try {
          await tx;
          ref.add(bucket, payout);
        } catch {
          // Capacity rejections are legal; the reference tree simply does not record them.
        }
      }
      for (let i = 0; i < 15; i++) {
        const from = rnd(800) - 40;
        const to = rnd(800) - 40;
        expect(await book.rangeCollateral(eventId, from, to)).to.equal(ref.range(from, to));
      }
    });

    it("rejects invalid or oversized bucket ranges", async () => {
      const { book, eventId } = await setup();
      await expect(book.bucketsInRange(eventId, 5, 4)).to.be.revertedWithCustomError(
        book,
        "BucketOutOfRange",
      );
      await expect(book.bucketsInRange(eventId, 0, 721)).to.be.revertedWithCustomError(
        book,
        "BucketOutOfRange",
      );
    });

    it("rejects unknown policies", async () => {
      const { book } = await deployCore();
      await expect(book.getPolicy(1)).to.be.revertedWithCustomError(book, "UnknownPolicy");
    });

    it("works for a second category with its own axis", async () => {
      const { book, registry } = await deployCore();
      const now = await time.latest();
      await book.createEvent(RAIN_24H, "Chennai", "13.08,80.27|2026-09-01", now + 100, now + 200);
      expect(await book.windowOf(1)).to.equal(
        // rain: sigma floor 1 mm, 2 sources, rho0 0.2 -> N_att 1.667, sigma_att 0.775, z1 2.807 -> 3 buckets
        3n,
      );
      expect(await registry.activeSourceCount(RAIN_24H)).to.equal(2n);
    });
  });

  describe("claims", () => {
    async function settled() {
      const ctx = await setup();
      const { book, alice, bob, eventId } = ctx;
      await book.connect(alice).bind(eventId, 60, eth("1"), { value: eth("1") });
      await book.connect(bob).bind(eventId, 130, eth("2"), { value: eth("1") });
      return ctx;
    }

    it("pays a policy once its bucket is inside the pay cursor", async () => {
      const { book, vault, mockEngine, alice, eventId } = await settled();
      await expect(book.connect(alice).claim(1)).to.be.revertedWithCustomError(
        book,
        "NotSettledPaying",
      );
      await mockEngine.setPayCursor(eventId, 60);
      await mockEngine.settlePay(eth("1"));
      const before = await ethers.provider.getBalance(alice.address);
      const tx = await book.connect(alice).claim(1);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      expect((await ethers.provider.getBalance(alice.address)) - before + gas).to.equal(eth("1"));
      await expect(tx).to.emit(book, "Claimed").withArgs(1, alice.address, eth("1"));
      expect((await book.getPolicy(1)).claimed).to.equal(true);
      expect(await vault.claimable()).to.equal(0n);
    });

    it("never pays twice and never pays an unsettled bucket", async () => {
      const { book, mockEngine, alice, bob, eventId } = await settled();
      await mockEngine.setPayCursor(eventId, 60);
      await mockEngine.settlePay(eth("1"));
      await book.connect(alice).claim(1);
      await expect(book.connect(alice).claim(1)).to.be.revertedWithCustomError(
        book,
        "AlreadyClaimed",
      );
      await expect(book.connect(bob).claim(2)).to.be.revertedWithCustomError(
        book,
        "NotSettledPaying",
      );
    });

    it("rejects unknown policies and a missing engine", async () => {
      const { book, alice, eventId } = await settled();
      await expect(book.connect(alice).claim(99)).to.be.revertedWithCustomError(
        book,
        "UnknownPolicy",
      );
      await book.setEngine(ethers.ZeroAddress);
      await expect(book.connect(alice).claim(1)).to.be.revertedWithCustomError(
        book,
        "EngineNotSet",
      );
      void eventId;
    });

    it("lets only the admin set the engine", async () => {
      const { book, alice } = await settled();
      await expect(book.connect(alice).setEngine(alice.address)).to.be.revertedWithCustomError(
        book,
        "AccessControlUnauthorizedAccount",
      );
    });
  });
});
