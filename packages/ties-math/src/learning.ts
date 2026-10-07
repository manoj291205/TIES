import { Fenwick } from "./fenwick";
import { WAD, mulDiv } from "./wad";

export interface LearningParams {
  bucketWidth: bigint;
  s: bigint;
  eps: bigint;
  gamma: bigint;
  mu: bigint;
  rho0: bigint;
}

export interface Reputation {
  alpha: bigint;
  beta: bigint;
}

/** Reputation as the weight alpha / (alpha + beta) in WAD. */
export function reputationWeight(r: Reputation): bigint {
  return (r.alpha * WAD) / (r.alpha + r.beta);
}

/**
 * Share of the event's collateral (WAD) whose pay / no-pay decision differs when the event is
 * judged at `x` instead of the final value: thresholds in (min, max].
 */
export function flipShare(
  tree: Fenwick,
  total: bigint,
  bucketWidth: bigint,
  x: bigint,
  finalValue: bigint,
): bigint {
  if (total === 0n) return 0n;
  const lo = x < finalValue ? x : finalValue;
  const hi = x < finalValue ? finalValue : x;
  const from = Number(lo / bucketWidth) + 1;
  const to = Number(hi / bucketWidth);
  if (from > to) return 0n;
  return mulDiv(tree.range(from, to), WAD, total);
}

/** Reputation after an oracle reported `x` on an event that finalized at `finalValue`. */
export function updateReputation(
  p: LearningParams,
  rep: Reputation,
  x: bigint,
  finalValue: bigint,
  flip: bigint,
): Reputation {
  const gap = x > finalValue ? x - finalValue : finalValue - x;
  const accurate = mulDiv(gap, WAD, p.s) <= p.eps;
  return {
    alpha: mulDiv(p.gamma, rep.alpha, WAD) + (accurate ? WAD - flip : 0n),
    beta: mulDiv(p.gamma, rep.beta, WAD) + flip + (accurate ? 0n : WAD),
  };
}

/** Reputation after a committee member failed to reveal. */
export function silentPenalty(p: LearningParams, rep: Reputation): Reputation {
  return { alpha: rep.alpha, beta: mulDiv(p.gamma, rep.beta, WAD) + WAD };
}

export interface DependenceUpdate {
  a: number;
  b: number;
  rho: bigint;
}

/**
 * New dependence for every pair of distinct sources present among the reports. Sources are
 * ordered by first appearance; `current(a, b)` returns the stored (or prior) dependence.
 */
export function updateDependence(
  p: LearningParams,
  reports: { source: number; value: bigint }[],
  finalValue: bigint,
  current: (a: number, b: number) => bigint,
): DependenceUpdate[] {
  const ids: number[] = [];
  const sums: bigint[] = [];
  const counts: bigint[] = [];
  for (const r of reports) {
    let slot = ids.indexOf(r.source);
    if (slot < 0) {
      slot = ids.length;
      ids.push(r.source);
      sums.push(0n);
      counts.push(0n);
    }
    sums[slot] += ((r.value - finalValue) * WAD) / p.s; // BigInt division truncates toward zero
    counts[slot] += 1n;
  }
  const mean = sums.map((sum, i) => sum / counts[i]);
  const abs = (v: bigint): bigint => (v < 0n ? -v : v);

  const out: DependenceUpdate[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const together =
        abs(mean[i]) > p.eps && abs(mean[j]) > p.eps && mean[i] > 0n === mean[j] > 0n;
      const old = current(ids[i], ids[j]);
      let next = mulDiv(WAD - p.mu, old, WAD) + (together ? p.mu : 0n);
      if (next < p.rho0) next = p.rho0;
      if (next > WAD) next = WAD;
      out.push({ a: ids[i], b: ids[j], rho: next });
    }
  }
  return out;
}
