export const WAD = 10n ** 18n;

/** Parse a decimal string such as "1.8" into a WAD fixed-point bigint. */
export function parseWad(value: string): bigint {
  const [whole, frac = ""] = value.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  const negative = whole.startsWith("-");
  const w = BigInt(whole.replace("-", "") || "0");
  const result = w * WAD + BigInt(padded || "0");
  return negative ? -result : result;
}

/** floor(a * b / d), matching OpenZeppelin Math.mulDiv. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

/** ceil(a * b / d), matching Math.mulDiv with Rounding.Ceil. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

/** a * b / WAD rounded up. */
export function mulWadUp(a: bigint, b: bigint): bigint {
  return mulDivCeil(a, b, WAD);
}

/** Integer square root (floor), matching OpenZeppelin Math.sqrt. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Square root of a WAD value, returned as WAD (rounded down). */
export function sqrtWad(x: bigint): bigint {
  return isqrt(x * WAD);
}
