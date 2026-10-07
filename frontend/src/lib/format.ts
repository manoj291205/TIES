import { formatEther } from "ethers";

/** ETH with a fixed number of decimals (4 by default); an em dash for missing values. */
export function fmtEth(value: number | null | undefined, decimals = 4): string {
  if (value == null || Number.isNaN(value)) return "—";
  return Number(value).toFixed(decimals);
}

/** wei -> ETH as a number (display only; never used for contract arithmetic). */
export function weiToEth(wei: bigint): number {
  return Number(formatEther(wei));
}

/** wei -> "3.0000" with `decimals` places, exact (no float rounding of the digits). */
export function fmtWei(wei: bigint, decimals = 4): string {
  const scale = 10n ** BigInt(18 - decimals);
  const rounded = (wei + scale / 2n) / scale;
  const whole = rounded / 10n ** BigInt(decimals);
  const frac = (rounded % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
  return decimals === 0
    ? whole.toLocaleString("en-US")
    : `${whole.toLocaleString("en-US")}.${frac}`;
}

export function fmtInt(value: number | bigint): string {
  return Number(value).toLocaleString("en-US");
}

/** `0x7099…79C8`; strings that are already shortened pass through. */
export function shortAddr(address: string | null | undefined): string {
  if (!address) return "";
  if (address.includes("…")) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Report values are milli-units on chain; thresholds are whole units. */
export function milliToUnits(milli: bigint | number): number {
  return Number(milli) / 1000;
}

/** "3 h 12 min", "45 s": a coarse duration for countdowns. */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0)
    return `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Interval as "[125.6, 136.0] min" (one decimal). */
export function fmtInterval(lower: number, upper: number | null, unit: string): string {
  const hi = upper == null || !Number.isFinite(upper) ? "∞" : upper.toFixed(1);
  return `[${lower.toFixed(1)}, ${hi}] ${unit}`;
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

let uidCounter = 0;
export function uid(prefix = "ties"): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}
