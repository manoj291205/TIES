import { keccak256, toUtf8Bytes } from "ethers";
import fs from "node:fs";
import path from "node:path";

/** Ground truth the mock sources read: observation key -> true value (minutes or mm). */
export class TruthStore {
  private readonly values = new Map<string, number>();

  constructor(file = path.join(__dirname, "..", "truth.json")) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>;
      for (const [k, v] of Object.entries(parsed)) this.values.set(k, v);
    } catch {
      // no truth file: every event needs an explicit PUT /truth
    }
  }

  get(key: string): number | undefined {
    return this.values.get(key);
  }

  set(key: string, value: number): void {
    this.values.set(key, value);
  }

  all(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
}

/** Deterministic standard normal draw for (seed, source, key): the same source says the same thing twice. */
export function gaussian(seed: string, sourceKey: string, eventKey: string): number {
  const h = keccak256(toUtf8Bytes(`${seed}|${sourceKey}|${eventKey}`));
  let a = parseInt(h.slice(2, 10), 16) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const u1 = Math.max(next(), 1e-12);
  const u2 = next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
