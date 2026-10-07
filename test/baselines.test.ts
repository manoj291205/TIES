import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const eth = ethers.parseEther;
const milli = (n: number) => BigInt(n) * 1000n;

async function setup(name: string, oracleCount: number) {
  const signers = await ethers.getSigners();
  const [admin, holder, ...rest] = signers;
  const c = await (await ethers.getContractFactory(name)).deploy(admin.address);
  const oracles = rest.slice(0, oracleCount);
  for (let i = 0; i < oracles.length; i++) await c.setOracle(oracles[i].address, i + 1);
  await c.fund({ value: eth("100") });
  const now = await time.latest();
  await c.createEvent(1, now + 1000);
  return { c, admin, holder, oracles, rest };
}

async function bindAt(
  c: Awaited<ReturnType<typeof setup>>["c"],
  holder: Awaited<ReturnType<typeof setup>>["holder"],
  bucket: number,
  payout = "1",
) {
  await c.connect(holder).bind(1, bucket, eth(payout), { value: eth("0.1") });
}

describe("Baselines", () => {
  it("Single: the first report decides every policy", async () => {
    const { c, holder, oracles } = await setup("BaselineSingle", 2);
    await bindAt(c, holder, 100);
    await bindAt(c, holder, 150);
    await expect(c.settleAll(1)).to.be.revertedWithCustomError(c, "NotReady");
    await c.connect(oracles[0]).report(1, milli(120));
    await c.settleAll(1);
    expect(await c.claimable(holder.address)).to.equal(eth("1"));
    expect(await c.locked()).to.equal(0n);
    await c.connect(holder).claim();
    expect(await c.claimable(holder.address)).to.equal(0n);
    await expect(c.connect(holder).claim()).to.be.revertedWithCustomError(c, "NothingToClaim");
    await expect(c.settleAll(1)).to.be.revertedWithCustomError(c, "AlreadySettled");
  });

  it("Avg2: needs two reports and averages them", async () => {
    const { c, holder, oracles } = await setup("BaselineAvg2", 3);
    await bindAt(c, holder, 130);
    await c.connect(oracles[0]).report(1, milli(100));
    await expect(c.settleAll(1)).to.be.revertedWithCustomError(c, "NotReady");
    await c.connect(oracles[1]).report(1, milli(170)); // average 135
    await c.settleAll(1);
    expect(await c.claimable(holder.address)).to.equal(eth("1"));
    expect(await c.reportsOf(1)).to.have.length(2);
  });

  it("Median3: two reports give their mean, three give the middle value", async () => {
    const a = await setup("BaselineMedian3", 3);
    await bindAt(a.c, a.holder, 125);
    await a.c.connect(a.oracles[0]).report(1, milli(100));
    await a.c.connect(a.oracles[1]).report(1, milli(140));
    await a.c.settleAll(1); // mean 120 < 125: no pay
    expect(await a.c.claimable(a.holder.address)).to.equal(0n);

    const b = await setup("BaselineMedian3", 3);
    await bindAt(b.c, b.holder, 125);
    for (const [i, v] of [100, 400, 130].entries())
      await b.c.connect(b.oracles[i]).report(1, milli(v));
    await b.c.settleAll(1); // median 130 >= 125
    expect(await b.c.claimable(b.holder.address)).to.equal(eth("1"));
  });

  it("Median7: waits for seven reports and uses their median", async () => {
    const { c, holder, oracles } = await setup("BaselineMedian7", 7);
    await bindAt(c, holder, 100);
    for (let i = 0; i < 6; i++) await c.connect(oracles[i]).report(1, milli(90 + i));
    await expect(c.settleAll(1)).to.be.revertedWithCustomError(c, "NotReady");
    await c.connect(oracles[6]).report(1, milli(500));
    await c.settleAll(1); // sorted 90..95,500 -> median 93 < 100
    expect(await c.claimable(holder.address)).to.equal(0n);
    expect(await c.free()).to.be.gt(eth("100"));
  });

  it("rejects unregistered reporters, double reports, late binds and cheap premiums", async () => {
    const { c, holder, oracles, rest } = await setup("BaselineSingle", 1);
    await expect(c.connect(rest[5]).report(1, 1n)).to.be.revertedWithCustomError(c, "NotOracle");
    await c.connect(oracles[0]).report(1, milli(10));
    await expect(c.connect(oracles[0]).report(1, 1n)).to.be.revertedWithCustomError(
      c,
      "AlreadyReported",
    );
    await expect(
      c.connect(holder).bind(1, 10, eth("1"), { value: 1n }),
    ).to.be.revertedWithCustomError(c, "PremiumTooLow");
    await expect(
      c.connect(holder).bind(1, 10, eth("1000"), { value: eth("30") }),
    ).to.be.revertedWithCustomError(c, "NotEnoughLiquidity");
    await expect(
      c.connect(holder).bind(9, 10, eth("1"), { value: eth("0.1") }),
    ).to.be.revertedWithCustomError(c, "UnknownEvent");
    await time.increase(2000);
    await expect(
      c.connect(holder).bind(1, 10, eth("1"), { value: eth("0.1") }),
    ).to.be.revertedWithCustomError(c, "CutoffPassed");
    expect(await c.policyCount(1)).to.equal(0n);
  });

  it("caps reports per event and exposes policies", async () => {
    const { c, holder, oracles, rest } = await setup("BaselineMedian7", 8);
    await bindAt(c, holder, 5);
    const p = await c.policyAt(1, 0);
    expect(p.bucket).to.equal(5n);
    for (let i = 0; i < 8; i++) await c.connect(oracles[i]).report(1, milli(i));
    await c.setOracle(rest[10].address, 9);
    await expect(c.connect(rest[10]).report(1, 1n)).to.be.revertedWithCustomError(
      c,
      "TooManyReports",
    );
  });
});
