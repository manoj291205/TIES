import { expect } from "chai";
import { Fenwick } from "../src";

describe("Fenwick", () => {
  it("matches brute force on random operations", () => {
    const size = 97;
    const tree = new Fenwick(size);
    const flat = new Array<bigint>(size).fill(0n);
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 300; i++) {
      const b = rnd(size);
      const amt = BigInt(rnd(1000) + 1);
      tree.add(b, amt);
      flat[b] += amt;
      const from = rnd(size + 20) - 10;
      const to = rnd(size + 20) - 10;
      let expected = 0n;
      for (let k = Math.max(from, 0); k <= Math.min(to, size - 1); k++) expected += flat[k];
      expect(tree.range(from, to)).to.equal(expected);
    }
  });

  it("rejects out-of-range buckets", () => {
    expect(() => new Fenwick(5).add(5, 1n)).to.throw();
  });
});
