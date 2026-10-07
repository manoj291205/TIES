import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCore, eth } from "./helpers/deploy";

type Core = Awaited<ReturnType<typeof deployCore>>;

describe("Vault", () => {
  async function setup() {
    const ctx = await deployCore();
    const { vault, lp1, lp2, admin } = ctx;
    await vault.connect(lp1).deposit({ value: eth("10") });
    await vault.connect(lp2).deposit({ value: eth("20") });
    // The admin acts as the policy book in these accounting tests.
    await vault.grantRole(await vault.BOOK_ROLE(), admin.address);
    return ctx;
  }

  async function conserved(vault: Core["vault"]) {
    const balance = await ethers.provider.getBalance(await vault.getAddress());
    const free = await vault.freeLiquidity();
    expect(free + (await vault.locked()) + (await vault.claimable())).to.equal(balance);
  }

  describe("shares", () => {
    it("mints the first deposit 1:1 minus dead shares", async () => {
      const { vault, lp1 } = await deployCore();
      await expect(vault.connect(lp1).deposit({ value: eth("1") }))
        .to.emit(vault, "Deposit")
        .withArgs(lp1.address, eth("1"), eth("1") - 1000n);
      expect(await vault.sharesOf(await vault.DEAD_ADDRESS())).to.equal(1000n);
      expect(await vault.totalShares()).to.equal(eth("1"));
    });

    it("prices later deposits pro rata, including earned premiums", async () => {
      const { vault, lp1, lp2, alice } = await deployCore();
      await vault.connect(lp1).deposit({ value: eth("10") });
      await alice.sendTransaction({ to: await vault.getAddress(), value: eth("10") });
      const supply = await vault.totalShares();
      const expected = (eth("10") * supply) / eth("20");
      await vault.connect(lp2).deposit({ value: eth("10") });
      expect(await vault.sharesOf(lp2.address)).to.equal(expected);
      expect(expected).to.be.lt(eth("10"));
    });

    it("rejects zero, too-small first and zero-share deposits", async () => {
      const { vault, lp1, alice } = await deployCore();
      await expect(vault.connect(lp1).deposit({ value: 0 })).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount",
      );
      await expect(vault.connect(lp1).deposit({ value: 1000 })).to.be.revertedWithCustomError(
        vault,
        "DepositTooSmall",
      );
      await vault.connect(lp1).deposit({ value: eth("1") });
      await alice.sendTransaction({ to: await vault.getAddress(), value: eth("1000") });
      await expect(vault.connect(lp1).deposit({ value: 1 })).to.be.revertedWithCustomError(
        vault,
        "ZeroShares",
      );
    });

    it("resists the donation (inflation) attack", async () => {
      const { vault, lp1, lp2, alice } = await deployCore();
      // Attacker makes the smallest possible first deposit, then donates a large amount.
      await vault.connect(alice).deposit({ value: 1001n });
      await lp1.sendTransaction({ to: await vault.getAddress(), value: eth("100") });
      // The victim must still receive shares worth almost all of their deposit.
      await vault.connect(lp2).deposit({ value: eth("100") });
      const worth = await vault.convertToAssets(await vault.sharesOf(lp2.address));
      expect(worth).to.be.gt(eth("100") - eth("100") / 1000n);
    });
  });

  describe("withdrawals", () => {
    it("lets an LP withdraw free liquidity and burns rounded-up shares", async () => {
      const { vault, lp1 } = await setup();
      const before = await vault.sharesOf(lp1.address);
      await expect(vault.connect(lp1).withdraw(eth("4")))
        .to.emit(vault, "Withdraw")
        .withArgs(lp1.address, eth("4"), (s: bigint) => s > 0n);
      expect(await vault.sharesOf(lp1.address)).to.be.lt(before);
      await conserved(vault);
    });

    it("never lets LPs take locked or claimable funds (P5)", async () => {
      const { vault, lp1, lp2, mockEngine } = await setup();
      await vault.lock(eth("28"));
      expect(await vault.freeLiquidity()).to.equal(eth("2"));
      expect(await vault.maxWithdraw(lp2.address)).to.equal(eth("2"));
      await expect(vault.connect(lp2).withdraw(eth("5"))).to.be.revertedWithCustomError(
        vault,
        "WithdrawExceedsMax",
      );
      // Settled payouts leave the LP-owned total.
      await mockEngine.settlePay(eth("10"));
      expect(await vault.claimable()).to.equal(eth("10"));
      expect(await vault.totalAssets()).to.equal(eth("20"));
      expect(await vault.maxWithdraw(lp1.address)).to.be.lte(eth("2"));
      await conserved(vault);
    });

    it("rejects zero withdrawals and withdrawals above the share value", async () => {
      const { vault, lp1 } = await setup();
      await expect(vault.connect(lp1).withdraw(0)).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount",
      );
      await expect(vault.connect(lp1).withdraw(eth("11"))).to.be.revertedWithCustomError(
        vault,
        "WithdrawExceedsMax",
      );
    });

    it("reports 0 conversion before any deposit", async () => {
      const { vault } = await deployCore();
      expect(await vault.convertToAssets(100)).to.equal(0n);
    });
  });

  describe("collateral accounting", () => {
    it("moves collateral locked -> claimable -> paid and locked -> free, conserving ETH", async () => {
      const { vault, mockEngine, alice } = await setup();
      await vault.lock(eth("6"));
      await conserved(vault);
      await mockEngine.settlePay(eth("2"));
      await mockEngine.settleNoPay(eth("1"));
      expect(await vault.locked()).to.equal(eth("3"));
      expect(await vault.claimable()).to.equal(eth("2"));
      await conserved(vault);
      const before = await ethers.provider.getBalance(alice.address);
      await vault.payClaim(alice.address, eth("2"));
      expect((await ethers.provider.getBalance(alice.address)) - before).to.equal(eth("2"));
      expect(await vault.claimable()).to.equal(0n);
      await conserved(vault);
    });

    it("rejects locking more than free and moving more than is held", async () => {
      const { vault, mockEngine, admin } = await setup();
      await expect(vault.lock(eth("31"))).to.be.revertedWithCustomError(vault, "InsufficientFree");
      await vault.lock(eth("1"));
      await expect(mockEngine.settlePay(eth("2"))).to.be.revertedWithCustomError(
        vault,
        "InsufficientBucket",
      );
      await expect(mockEngine.settleNoPay(eth("2"))).to.be.revertedWithCustomError(
        vault,
        "InsufficientBucket",
      );
      await expect(vault.payClaim(admin.address, 1)).to.be.revertedWithCustomError(
        vault,
        "InsufficientBucket",
      );
    });

    it("fails the claim if the recipient cannot receive ETH", async () => {
      const { vault, mockEngine } = await setup();
      await vault.lock(eth("1"));
      await mockEngine.settlePay(eth("1"));
      // The mock engine has no receive function, so the payout transfer fails.
      await expect(
        vault.payClaim(await mockEngine.getAddress(), eth("1")),
      ).to.be.revertedWithCustomError(vault, "TransferFailed");
    });
  });

  describe("access control", () => {
    it("restricts lock/unlock/move/pay to the right roles", async () => {
      const { vault, alice } = await setup();
      for (const call of [
        vault.connect(alice).lock(1),
        vault.connect(alice).unlock(1),
        vault.connect(alice).moveLockedToClaimable(1),
        vault.connect(alice).payClaim(alice.address, 1),
      ]) {
        await expect(call).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      }
    });
  });
});
