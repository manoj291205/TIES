import { WAD, mulDiv } from "./wad";

export interface PlannerParams {
  bucketWidth: bigint;
  nMin: bigint;
  rMin: bigint;
  rho0: bigint;
  kRound: number;
  kMax: number;
  zByRound: bigint[];
}

export interface PlanInput {
  round: number; // round just finalized (1-based)
  hasConsensus: boolean;
  insufficient: boolean;
  payCursor: number;
  noPayCursor: number;
  consensus: bigint; // milli-units
  sigma: bigint; // milli-units
  nEff: bigint; // WAD
  sourceIds: number[];
  sourceWeights: bigint[]; // WAD, one per represented source
  reporters: string[];
  /** Collateral per bucket, indexed by bucket number. */
  bucketAmounts: (bucket: number) => bigint;
}

export interface Candidate {
  oracle: string;
  source: number;
  reputation: bigint; // WAD
  /** keccak256(prevrandao, eventId, oracle) as a bigint, used only to break ties. */
  tieBreak: bigint;
}

export interface Plan {
  escalate: boolean;
  k: number;
  selected: string[];
  kInsufficient: number;
  kMargin: number;
  futile: boolean;
  bucket: number | null;
}

export const MAX_BUCKET_SCAN = 64;

const ceilWad = (x: bigint): bigint => (x + WAD - 1n) / WAD;
const bmax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The most valuable held bucket (see EscalationPlanner._valuableBucket). */
export function valuableBucket(
  input: PlanInput,
  p: PlannerParams,
): { any: boolean; bucket: number } {
  if (input.noPayCursor - input.payCursor < 2) return { any: false, bucket: 0 };
  const from = input.payCursor + 1;
  const to = input.noPayCursor - 1;
  const nearest = Math.min(
    Math.max(Number((input.consensus + p.bucketWidth / 2n) / p.bucketWidth), from),
    to,
  );
  let start = from;
  let end = to;
  if (to - from + 1 > MAX_BUCKET_SCAN) {
    start = nearest > from + MAX_BUCKET_SCAN / 2 ? nearest - MAX_BUCKET_SCAN / 2 : from;
    if (start + MAX_BUCKET_SCAN - 1 > to) start = to - (MAX_BUCKET_SCAN - 1);
    end = start + MAX_BUCKET_SCAN - 1;
  }
  let best = 0n;
  let bucket = 0;
  for (let b = start; b <= end; b++) {
    const amount = input.bucketAmounts(b);
    if (amount > best) {
      best = amount;
      bucket = b;
    }
  }
  return { any: best > 0n, bucket };
}

/**
 * Mirror of EscalationPlanner.plan. `rho(a, b)` is the learned (or prior) dependence between two
 * distinct sources; `candidates` is every active oracle of the category.
 */
export function planEscalation(
  input: PlanInput,
  p: PlannerParams,
  candidates: Candidate[],
  rho: (a: number, b: number) => bigint,
): Plan {
  const kInsufficient = input.insufficient ? Number(ceilWad(p.nMin - bmin(input.nEff, p.nMin))) : 0;

  let kMargin = 0;
  let futile = false;
  let bucket: number | null = null;
  if (input.hasConsensus) {
    const found = valuableBucket(input, p);
    if (found.any) {
      bucket = found.bucket;
      const theta = BigInt(found.bucket) * p.bucketWidth;
      const needed = input.consensus > theta ? input.consensus - theta : theta - input.consensus;
      if (needed === 0n) {
        futile = true;
      } else {
        const half = mulDiv(p.zByRound[input.round], input.sigma, WAD);
        const nNeeded = mulDiv(input.nEff, half * half, needed * needed);
        if (nNeeded > input.nEff) kMargin = Number(ceilWad(nNeeded - input.nEff));
        futile = kMargin > p.kRound * (p.kMax - input.round);
      }
    }
  }
  if (futile && !input.insufficient) {
    return { escalate: false, k: 0, selected: [], kInsufficient, kMargin, futile, bucket };
  }
  if (futile) kMargin = 0; // insufficient evidence: recruit for sufficiency regardless

  let k = Math.min(p.kRound, Math.max(kInsufficient, kMargin));
  if (k === 0) k = 1;

  // Pool of represented sources.
  const m = input.sourceIds.length;
  let sumWeight = 0n;
  let den = 0n;
  for (let s = 0; s < m; s++) {
    sumWeight += input.sourceWeights[s];
    for (let t = 0; t < m; t++) {
      const r = s === t ? WAD : rho(input.sourceIds[s], input.sourceIds[t]);
      den += mulDiv(input.sourceWeights[s] * input.sourceWeights[t], r, WAD);
    }
  }
  const nNow = den > 0n ? mulDiv(sumWeight * sumWeight, WAD, den) : 0n;

  const scored = candidates
    .filter(
      (c) =>
        c.reputation >= p.rMin &&
        !input.reporters.includes(c.oracle) &&
        !input.sourceIds.includes(c.source),
    )
    .map((c) => {
      let cross = 0n;
      for (let s = 0; s < m; s++) {
        cross += mulDiv(
          c.reputation * input.sourceWeights[s],
          rho(c.source, input.sourceIds[s]),
          WAD,
        );
      }
      const denNext = den + 2n * cross + c.reputation * c.reputation;
      const sumNext = sumWeight + c.reputation;
      const nNext = mulDiv(sumNext * sumNext, WAD, denNext);
      const gain = nNext > nNow ? nNext - nNow : 0n;
      return { c, score: mulDiv(gain, c.reputation, WAD) };
    });
  scored.sort((a, b) =>
    a.score !== b.score ? (a.score > b.score ? -1 : 1) : a.c.tieBreak < b.c.tieBreak ? -1 : 1,
  );
  const selected = scored.slice(0, k).map((x) => x.c.oracle);
  return {
    escalate: selected.length > 0,
    k,
    selected,
    kInsufficient,
    kMargin,
    futile,
    bucket,
  };
}

export { bmax };
