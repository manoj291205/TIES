import { WAD, isqrt, mulDiv, sqrtWad } from "./wad";

export interface AggregationInput {
  x: bigint[]; // report values, milli-units
  rep: bigint[]; // reputation weights R_i, WAD
  rho: bigint[][]; // n x n dependence (WAD); the diagonal is ignored (counts as 1.0)
  s: bigint;
  sigmaFloor: bigint;
  delta: bigint;
  dCut: bigint;
}

export interface AggregationResult {
  median: bigint;
  consensus: bigint;
  dispersion: bigint;
  nEff: bigint;
  sigma: bigint;
  weightSum: bigint;
  weights: bigint[];
}

/** Lower weighted median: smallest value whose cumulative weight reaches half the total. */
export function weightedMedian(x: bigint[], rep: bigint[]): bigint {
  const idx = x.map((_, i) => i);
  // Insertion sort, stable for equal values (matches the contract).
  for (let i = 1; i < idx.length; i++) {
    const key = idx[i];
    let j = i;
    while (j > 0 && x[idx[j - 1]] > x[key]) {
      idx[j] = idx[j - 1];
      j--;
    }
    idx[j] = key;
  }
  const total = rep.reduce((a, b) => a + b, 0n);
  let cum = 0n;
  for (const k of idx) {
    cum += rep[k];
    if (2n * cum >= total) return x[k];
  }
  return x[idx[idx.length - 1]];
}

const abs = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);

/** Spec 3.5 steps 1-8, with the same integer rounding as contracts/libraries/Aggregation.sol. */
export function aggregate(input: AggregationInput): AggregationResult {
  const n = input.x.length;
  if (n === 0) throw new Error("no reports");
  const median = weightedMedian(input.x, input.rep);

  const w = input.x.map((xi, i) => {
    const d = mulDiv(abs(xi, median), WAD, input.s);
    if (d > input.dCut) return 0n;
    const t = mulDiv(d, WAD, input.delta);
    const agreement = mulDiv(WAD, WAD, WAD + mulDiv(t, t, WAD));
    return mulDiv(input.rep[i], agreement, WAD);
  });
  const weightSum = w.reduce((a, b) => a + b, 0n);
  const empty = {
    median,
    consensus: 0n,
    dispersion: 0n,
    nEff: 0n,
    sigma: 0n,
    weightSum,
    weights: w,
  };
  if (weightSum === 0n) return empty;

  const consensus = w.reduce((acc, wi, i) => acc + wi * input.x[i], 0n) / weightSum;
  const dispersion =
    w.reduce((acc, wi, i) => {
      const d = abs(input.x[i], consensus);
      return acc + wi * d * d;
    }, 0n) / weightSum;

  let den = 0n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const rho = i === j ? WAD : input.rho[i][j];
      den += mulDiv(w[i] * w[j], rho, WAD);
    }
  }
  const nEff = mulDiv(weightSum * weightSum, WAD, den);
  const spread = isqrt(dispersion + input.sigmaFloor * input.sigmaFloor);
  const sigma = mulDiv(spread, WAD, sqrtWad(nEff));
  return { median, consensus, dispersion, nEff, sigma, weightSum, weights: w };
}

/** Round interval [V - z*sigma, V + z*sigma], clamped at 0. */
export function roundInterval(
  consensus: bigint,
  sigma: bigint,
  z: bigint,
): { lo: bigint; hi: bigint } {
  const half = mulDiv(z, sigma, WAD);
  return { lo: consensus > half ? consensus - half : 0n, hi: consensus + half };
}
