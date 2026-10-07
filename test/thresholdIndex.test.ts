import { expect } from "chai";
import { ethers } from "hardhat";
import { Fenwick } from "../packages/ties-math/src";
import { makeRng } from "./helpers/deploy";

describe("ThresholdIndex (Fenwick tree)", () => {
  async function deploy(size: number) {
    return (await ethers.getContractFactory("ThresholdIndexHarness")).deploy(size);
  }

  it("matches a brute-force array on random adds and range queries", async () => {
    const size = 64;
    const harness = await deploy(size);
    const flat = new Array<bigint>(size).fill(0n);
    const rnd = makeRng(7);
    for (let i = 0; i < 120; i++) {
      const bucket = rnd(size);
      const amount = BigInt(rnd(10_000) + 1);
      await harness.add(bucket, amount);
      flat[bucket] += amount;
      if (i % 4 === 0) {
        const from = rnd(size + 16) - 8;
        const to = rnd(size + 16) - 8;
        let expected = 0n;
        for (let k = Math.max(from, 0); k <= Math.min(to, size - 1); k++) expected += flat[k];
        expect(await harness.range(from, to)).to.equal(expected);
      }
    }
    for (let k = 0; k < size; k++) {
      let expected = 0n;
      for (let j = 0; j <= k; j++) expected += flat[j];
      expect(await harness.prefix(k)).to.equal(expected);
    }
  });

  it("agrees with the TypeScript reference tree", async () => {
    const size = 721;
    const harness = await deploy(size);
    const ref = new Fenwick(size);
    const rnd = makeRng(99);
    for (let i = 0; i < 40; i++) {
      const bucket = rnd(size);
      const amount = BigInt(rnd(1_000_000) + 1);
      await harness.add(bucket, amount);
      ref.add(bucket, amount);
    }
    for (let i = 0; i < 25; i++) {
      const from = rnd(size + 50) - 25;
      const to = rnd(size + 50) - 25;
      expect(await harness.range(from, to)).to.equal(ref.range(from, to));
    }
  });

  it("clamps negative and oversized arguments and returns 0 for empty ranges", async () => {
    const harness = await deploy(10);
    await harness.add(0, 5n);
    await harness.add(9, 7n);
    expect(await harness.prefix(-1)).to.equal(0n);
    expect(await harness.prefix(100)).to.equal(12n);
    expect(await harness.range(-5, 100)).to.equal(12n);
    expect(await harness.range(5, 4)).to.equal(0n);
    expect(await harness.range(3, 3)).to.equal(0n);
  });

  it("reverts when adding outside the axis", async () => {
    const harness = await deploy(10);
    await expect(harness.add(10, 1n)).to.be.revertedWithCustomError(harness, "BucketOutOfRange");
  });
});
