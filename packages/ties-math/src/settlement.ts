import { Fenwick } from "./fenwick";

export interface Cursors {
  /** Largest bucket settled as paying; -1 if none. */
  pay: number;
  /** Smallest bucket settled as not paying; bucketCount if none. */
  noPay: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Spec 3.6 cursors for an interval [lower, upper] (milli-units), clamped so settled buckets
 * never reverse and the pay and no-pay ranges never overlap.
 */
export function nextCursors(
  old: Cursors,
  bucketCount: number,
  bucketWidth: bigint,
  lower: bigint,
  upper: bigint,
): Cursors {
  let pay = Number(lower / bucketWidth);
  pay = Math.min(pay, bucketCount - 1);
  pay = Math.max(pay, old.pay);
  pay = Math.min(pay, old.noPay - 1);
  let noPay = Number(upper / bucketWidth) + 1;
  noPay = Math.min(noPay, bucketCount);
  noPay = Math.min(noPay, old.noPay);
  noPay = Math.max(noPay, pay + 1);
  return { pay, noPay };
}

/** Collateral newly settled by moving the cursors, using Fenwick range queries. */
export function settledAmounts(
  tree: Fenwick,
  old: Cursors,
  next: Cursors,
): { newPay: bigint; newNoPay: bigint } {
  const newPay = next.pay > old.pay ? tree.range(old.pay + 1, next.pay) : 0n;
  const newNoPay = next.noPay < old.noPay ? tree.range(next.noPay, old.noPay - 1) : 0n;
  return { newPay, newNoPay };
}

/** Brute-force reference: evaluates every policy individually (used to check range settlement). */
export function bruteForceSettlement(
  policies: { bucket: number; payout: bigint }[],
  bucketWidth: bigint,
  lower: bigint,
  upper: bigint,
): { pay: bigint; noPay: bigint; held: bigint } {
  let pay = 0n;
  let noPay = 0n;
  let held = 0n;
  for (const p of policies) {
    const threshold = BigInt(p.bucket) * bucketWidth;
    if (threshold <= lower) pay += p.payout;
    else if (threshold > upper) noPay += p.payout;
    else held += p.payout;
  }
  return { pay, noPay, held };
}

export { clamp };
