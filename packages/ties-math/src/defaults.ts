import { WAD, parseWad } from "./wad";

const eth = (v: string): bigint => parseWad(v);

/** Category parameters exactly as stored in TIESRegistry (spec section 3.2). */
export interface CategoryParams {
  unit: string;
  bucketCount: number;
  maxReportsPerEvent: number;
  kMax: number;
  kRound: number;
  commitWindow: number;
  revealWindow: number;
  challengePeriod: number;
  bucketWidth: bigint;
  s: bigint;
  sigmaFloor: bigint;
  delta: bigint;
  dCut: bigint;
  nMin: bigint;
  rho0: bigint;
  uMin: bigint;
  rMin: bigint;
  alpha0: bigint;
  beta0: bigint;
  gamma: bigint;
  mu: bigint;
  eps: bigint;
  capacityCapPerWindow: bigint;
  eta: bigint;
  margin: bigint;
  escalationFee: bigint;
  zByRound: bigint[];
  curveTheta: bigint[];
  curveProb: bigint[];
}

export const FLIGHT_DELAY = 0;
export const RAIN_24H = 1;

const common = {
  maxReportsPerEvent: 16,
  kMax: 3,
  kRound: 2,
  commitWindow: 120,
  revealWindow: 120,
  challengePeriod: 300,
  bucketWidth: 1000n,
  delta: eth("1.0"),
  dCut: eth("4.0"),
  nMin: eth("1.8"),
  rho0: eth("0.2"),
  uMin: 2n * WAD,
  rMin: eth("0.6"),
  alpha0: eth("4"),
  beta0: eth("1"),
  gamma: eth("0.98"),
  mu: eth("0.2"),
  eps: eth("0.5"),
  capacityCapPerWindow: 10n * WAD,
  eta: eth("0.25"),
  margin: eth("0.20"),
  escalationFee: eth("0.002"),
  zByRound: [eth("2.807"), eth("3.023"), eth("3.227")],
};

const curve = (points: [number, string][]): { theta: bigint[]; prob: bigint[] } => ({
  theta: points.map(([t]) => BigInt(t) * 1000n),
  prob: points.map(([, p]) => eth(p)),
});

const flightCurve = curve([
  [0, "1.0"],
  [15, "0.60"],
  [30, "0.40"],
  [60, "0.22"],
  [120, "0.09"],
  [180, "0.045"],
  [240, "0.025"],
  [360, "0.01"],
  [720, "0.002"],
]);

const rainCurve = curve([
  [0, "1.0"],
  [10, "0.35"],
  [25, "0.18"],
  [50, "0.08"],
  [80, "0.04"],
  [120, "0.015"],
  [200, "0.004"],
  [300, "0.001"],
]);

export const FLIGHT_DELAY_PARAMS: CategoryParams = {
  ...common,
  unit: "min",
  bucketCount: 721,
  s: 15_000n,
  sigmaFloor: 3_000n,
  curveTheta: flightCurve.theta,
  curveProb: flightCurve.prob,
};

export const RAIN_24H_PARAMS: CategoryParams = {
  ...common,
  unit: "mm",
  bucketCount: 301,
  s: 5_000n,
  sigmaFloor: 1_000n,
  curveTheta: rainCurve.theta,
  curveProb: rainCurve.prob,
};
