import { SOURCES } from "../../services/shared/src/topology";
import { gaussian } from "../../services/sources/src/truth";
import type { NodeMode, ScenarioDef, SourceBehaviour } from "../scenarios";

/** Flight sources S1-S6, plus a second key on S2 (oracle index 6), as in nodes.json. */
export const ORACLE_SOURCES = [1, 2, 3, 4, 5, 6, 2];
export const nodeId = (oracleIndex: number) => `n${oracleIndex + 1}`;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inverse of the standard normal CDF (Acklam's approximation; error below 1.2e-9). */
export function normInv(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** z_r = Phi^-1(1 - alpha_r / 2) with alpha_r = alpha / 2^r (spec 3.2). */
export const zForRound = (alpha: number, round: number) =>
  normInv(1 - alpha / Math.pow(2, round) / 2);

export interface World {
  truth: number;
  /** Reading of a source in minutes, or null when the source is down. */
  read(sourceId: number): number | null;
  nodeMode(oracleIndex: number): NodeMode;
}

const sigmaOf = (sourceId: number) => SOURCES.find((s) => s.id === sourceId)!.sigma;

/** A world for one event: ground truth plus how each source and oracle node behaves. */
export function makeWorld(
  sc: Pick<ScenarioDef, "sources" | "nodes">,
  truth: number,
  eventKey: string,
): World {
  const behaviour = (sourceId: number): SourceBehaviour => sc.sources?.[`S${sourceId}`] ?? {};
  return {
    truth,
    read(sourceId) {
      const b = behaviour(sourceId);
      if (b.down) return null;
      const sigma = b.sigma ?? sigmaOf(sourceId);
      const offset = b.mode === "offset" ? (b.offset ?? 0) : 0;
      const v = truth + offset + gaussian("exp", `S${sourceId}`, eventKey) * sigma;
      return Math.min(Math.max(v, 0), 720);
    },
    nodeMode: (i) => sc.nodes?.[nodeId(i)] ?? "honest",
  };
}

export interface PolicyDraw {
  bucket: number;
  payoutEth: string;
}

/** Thresholds spread around the truth; `spread` is the half-width in minutes. */
export function drawPolicies(
  rng: () => number,
  truth: number,
  count: number,
  spread: number,
  payoutEth: string,
): PolicyDraw[] {
  const out: PolicyDraw[] = [];
  for (let i = 0; i < count; i++) {
    const d = Math.round((rng() * 2 - 1) * spread);
    out.push({ bucket: Math.min(720, Math.max(1, Math.round(truth) + d)), payoutEth });
  }
  return out;
}

export const shouldPay = (truth: number, bucket: number) => truth >= bucket;
