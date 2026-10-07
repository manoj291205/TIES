import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { fmtDuration, fmtEth, fmtWei, shortAddr } from "./format";
import { decodeError } from "./errors";
import { bucketState } from "../components/Charts";

describe("format", () => {
  it("formats ETH and wei with fixed decimals", () => {
    expect(fmtEth(3)).toBe("3.0000");
    expect(fmtEth(null)).toBe("—");
    expect(fmtWei(1_500_000_000_000_000_000n)).toBe("1.5000");
    expect(fmtWei(0n)).toBe("0.0000");
  });
  it("shortens addresses and durations", () => {
    expect(shortAddr("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("0x7099…79C8");
    expect(fmtDuration(75)).toBe("1m 15s");
  });
});

describe("bucketState (spec 3.6: pays iff threshold <= L, no pay iff threshold > U)", () => {
  it("settles single buckets on the boundaries", () => {
    expect(bucketState(125, 1, 125.6, 136, "live")).toBe("pay");
    expect(bucketState(126, 1, 125.6, 136, "live")).toBe("held");
    expect(bucketState(136, 1, 125.6, 136, "live")).toBe("held");
    expect(bucketState(137, 1, 125.6, 136, "live")).toBe("nopay");
  });
  it("holds everything without a valid interval", () => {
    expect(bucketState(10, 1, null, null, "live")).toBe("held");
    expect(bucketState(10, 1, 125, 136, "insufficient")).toBe("held");
  });
});

describe("decodeError", () => {
  const iface = new Interface(["error CutoffPassed(uint256 cutoff)"]);
  it("explains a custom error in plain language", () => {
    const data = iface.encodeErrorResult("CutoffPassed", [5n]);
    const d = decodeError({ data }, [iface]);
    expect(d.name).toBe("CutoffPassed");
    expect(d.message).toMatch(/closed/);
  });
  it("recognises a rejected signature", () => {
    expect(decodeError({ code: "ACTION_REJECTED" }, [iface]).rejected).toBe(true);
  });
});
