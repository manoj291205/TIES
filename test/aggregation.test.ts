import { expect } from "chai";
import { ethers } from "hardhat";
import { aggregate, weightedMedian, WAD } from "../packages/ties-math/src";
import { makeRng } from "./helpers/deploy";

describe("Aggregation (on-chain vs ties-math)", () => {
  const params = { s: 15_000n, sigmaFloor: 3_000n, delta: WAD, dCut: 4n * WAD };

  async function deploy() {
    return (await ethers.getContractFactory("AggregationHarness")).deploy();
  }

  function randomInput(rnd: (n: number) => number, n: number) {
    const centre = 100_000 + rnd(200_000);
    const x = Array.from({ length: n }, () => {
      const outlier = rnd(6) === 0;
      return BigInt(centre + (outlier ? rnd(150_000) - 75_000 : rnd(20_000) - 10_000));
    });
    const rep = Array.from({ length: n }, () => (WAD * BigInt(30 + rnd(70))) / 100n);
    const rho: bigint[][] = Array.from({ length: n }, () => new Array<bigint>(n).fill(0n));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        const v = (WAD * BigInt(20 + rnd(81))) / 100n;
        rho[i][j] = v;
        rho[j][i] = v;
      }
    }
    return { x, rep, rho };
  }

  it("matches the reference exactly on random inputs", async () => {
    const harness = await deploy();
    const rnd = makeRng(31337);
    for (let t = 0; t < 40; t++) {
      const n = 1 + rnd(16);
      const { x, rep, rho } = randomInput(rnd, n);
      const expected = aggregate({ x, rep, rho, ...params });
      const flat = rho.flat();
      const got = await harness.run(
        x,
        rep,
        flat,
        params.s,
        params.sigmaFloor,
        params.delta,
        params.dCut,
      );
      expect(got.median, `case ${t} median`).to.equal(expected.median);
      expect(got.consensus, `case ${t} V`).to.equal(expected.consensus);
      expect(got.dispersion, `case ${t} S2`).to.equal(expected.dispersion);
      expect(got.nEff, `case ${t} nEff`).to.equal(expected.nEff);
      expect(got.sigma, `case ${t} sigma`).to.equal(expected.sigma);
      expect(got.weightSum, `case ${t} weights`).to.equal(expected.weightSum);
    }
  });

  it("computes a lower weighted median that respects the weights", async () => {
    const harness = await deploy();
    const w = WAD;
    expect(await harness.weightedMedian([30n, 10n, 20n], [w, w, w])).to.equal(20n);
    // Even count with equal weights picks the lower middle value.
    expect(await harness.weightedMedian([10n, 20n, 30n, 40n], [w, w, w, w])).to.equal(20n);
    // A heavy weight on one value drags the median to it.
    expect(await harness.weightedMedian([10n, 20n, 90n], [w, w, 5n * w])).to.equal(90n);
    expect(weightedMedian([10n, 20n, 90n], [w, w, 5n * w])).to.equal(90n);
    expect(await harness.weightedMedian([7n], [w])).to.equal(7n);
  });

  it("treats identical sources as one: N_eff is 1.0 (single-source invariant)", async () => {
    const harness = await deploy();
    const rho = Array.from({ length: 16 }, () => WAD); // every pair fully dependent
    const x = Array.from({ length: 4 }, () => 130_000n);
    const rep = Array.from({ length: 4 }, () => (WAD * 8n) / 10n);
    const got = await harness.run(x, rep, rho, 15_000n, 3_000n, WAD, 4n * WAD);
    expect(got.nEff).to.equal(WAD);
  });

  it("gives independent sources an N_eff close to the report count", async () => {
    const harness = await deploy();
    const n = 4;
    const rho = Array.from({ length: n * n }, () => 0n);
    const x = Array.from({ length: n }, () => 130_000n);
    const rep = Array.from({ length: n }, () => WAD);
    const got = await harness.run(x, rep, rho, 15_000n, 3_000n, WAD, 4n * WAD);
    expect(got.nEff).to.equal(4n * WAD);
  });

  it("zeroes the weight of values beyond the hard outlier cut", async () => {
    const harness = await deploy();
    const n = 3;
    const rho = Array.from({ length: n * n }, () => 0n);
    const rep = [WAD, WAD, WAD];
    // 130, 131 and a wild 500: with s = 15 min the cut is 60 min, so 500 is rejected.
    const got = await harness.run(
      [130_000n, 131_000n, 500_000n],
      rep,
      rho,
      15_000n,
      3_000n,
      WAD,
      4n * WAD,
    );
    expect(got.consensus).to.be.lt(135_000n);
    expect(got.nEff).to.be.lt(3n * WAD);
  });

  it("reports an empty weight sum when every report has zero reputation", async () => {
    const harness = await deploy();
    const got = await harness.run([130_000n], [0n], [0n], 15_000n, 3_000n, WAD, 4n * WAD);
    expect(got.weightSum).to.equal(0n);
    expect(got.nEff).to.equal(0n);
  });

  it("rejects empty or inconsistent input", async () => {
    const harness = await deploy();
    await expect(
      harness.run([], [], [], 15_000n, 3_000n, WAD, 4n * WAD),
    ).to.be.revertedWithCustomError(harness, "NoReports");
    await expect(
      harness.run([1n], [WAD, WAD], [0n], 15_000n, 3_000n, WAD, 4n * WAD),
    ).to.be.revertedWithCustomError(harness, "LengthMismatch");
  });
});
