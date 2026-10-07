import { expect } from "chai";
import { WAD, isqrt, parseWad, sqrtWad, mulDivCeil } from "../src";

describe("wad helpers", () => {
  it("parses decimals", () => {
    expect(parseWad("1.8")).to.equal(18n * 10n ** 17n);
    expect(parseWad("0.002")).to.equal(2n * 10n ** 15n);
    expect(parseWad("4")).to.equal(4n * WAD);
  });

  it("isqrt is the floor square root", () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n, 10n ** 36n + 1n]) {
      const r = isqrt(n);
      expect(r * r <= n).to.equal(true);
      expect((r + 1n) * (r + 1n) > n).to.equal(true);
    }
  });

  it("sqrtWad of 4.0 is 2.0", () => {
    expect(sqrtWad(4n * WAD)).to.equal(2n * WAD);
  });

  it("mulDivCeil rounds up", () => {
    expect(mulDivCeil(7n, 1n, 2n)).to.equal(4n);
    expect(mulDivCeil(8n, 1n, 2n)).to.equal(4n);
  });
});
