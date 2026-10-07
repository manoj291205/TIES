import { WAD, mulDiv, mulDivCeil, mulWadUp, sqrtWad } from "./wad";

export interface PricingParams {
  bucketWidth: bigint;
  sigmaFloor: bigint;
  rho0: bigint;
  margin: bigint;
  escalationFee: bigint;
  zByRound: bigint[];
  curveTheta: bigint[];
  curveProb: bigint[];
}

/** Piecewise-linear interpolation of a non-increasing curve; clamps at both ends. */
export function interpolate(xs: bigint[], ys: bigint[], x: bigint): bigint {
  const n = xs.length;
  if (n === 0 || n !== ys.length) throw new Error("invalid curve");
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (xs[i] < x) i++;
  const [x0, x1, y0, y1] = [xs[i - 1], xs[i], ys[i - 1], ys[i]];
  return y0 - mulDiv(y0 - y1, x - x0, x1 - x0);
}

/** premium = ceil(ceil(payout * q(theta)) * (1 + margin)) + escalationFee. */
export function quote(p: PricingParams, bucket: bigint, payout: bigint): bigint {
  const q = interpolate(p.curveTheta, p.curveProb, bucket * p.bucketWidth);
  const risk = mulWadUp(payout, q);
  return mulWadUp(risk, WAD + p.margin) + p.escalationFee;
}

/** Half-width in buckets of the capacity window: ceil(z1 * sigma_att / bucketWidth). */
export function attainableWindow(sources: bigint, p: PricingParams): bigint {
  const nAtt = mulDiv(sources * WAD, WAD, WAD + (sources - 1n) * p.rho0);
  const sigmaAtt = mulDiv(p.sigmaFloor, WAD, sqrtWad(nAtt));
  return mulDivCeil(p.zByRound[0], sigmaAtt, WAD * p.bucketWidth);
}
