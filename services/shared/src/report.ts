import { AbiCoder, Wallet, getBytes, id, keccak256, toUtf8Bytes } from "ethers";
import type { ToolName } from "./topology";

/** JSON with sorted keys, so equal objects always hash equally. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, sort(val)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Input schema of each MCP tool (JSON-schema shape, used for the tool hash). */
export const TOOL_SCHEMAS: Record<ToolName, object> = {
  get_flight_delay: {
    type: "object",
    properties: {
      eventId: { type: "integer" },
      flight: { type: "string" },
      date: { type: "string" },
    },
    required: ["eventId", "flight", "date"],
  },
  get_rainfall_24h: {
    type: "object",
    properties: {
      eventId: { type: "integer" },
      lat: { type: "number" },
      lon: { type: "number" },
      date: { type: "string" },
    },
    required: ["eventId", "lat", "lon", "date"],
  },
};

/** keccak256 of the tool name followed by its canonical JSON input schema. */
export function toolHashOf(tool: ToolName): string {
  return keccak256(toUtf8Bytes(tool + canonicalJson(TOOL_SCHEMAS[tool])));
}

export const hashJson = (value: unknown): string => keccak256(toUtf8Bytes(canonicalJson(value)));

/** What a source signs: spec 3.4. */
export function reportDigest(p: {
  chainId: number | bigint;
  engine: string;
  eventId: number | bigint;
  value: bigint;
  ts: number | bigint;
  toolHash: string;
  argsHash: string;
  responseHash: string;
}): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256", "uint256", "uint256", "bytes32", "bytes32", "bytes32"],
      [p.chainId, p.engine, p.eventId, p.value, p.ts, p.toolHash, p.argsHash, p.responseHash],
    ),
  );
}

export async function signReportDigest(wallet: Wallet, digest: string): Promise<string> {
  return wallet.signMessage(getBytes(digest));
}

/** A signed report as returned by a source's MCP tool. */
export interface SignedReport {
  /** Milli-units, as a decimal string (JSON has no bigint). */
  value: string;
  ts: number;
  toolHash: string;
  argsHash: string;
  responseHash: string;
  signature: string;
}

export function commitHashOf(
  r: {
    value: bigint;
    ts: number | bigint;
    toolHash: string;
    argsHash: string;
    responseHash: string;
    signature: string;
  },
  salt: string,
  oracle: string,
): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "bytes32", "bytes32", "bytes32", "bytes", "bytes32", "address"],
      [r.value, r.ts, r.toolHash, r.argsHash, r.responseHash, r.signature, salt, oracle],
    ),
  );
}

export const randomSalt = (): string => id(`${Math.random()}:${Date.now()}:${process.pid}`);

/** Splits an observation key like "AI101|2026-10-12" or "13.08,80.27|2025-10-22". */
export function parseObservationKey(
  category: number,
  key: string,
  eventId: number,
): { tool: ToolName; args: Record<string, string | number> } {
  const [where, date] = key.split("|");
  if (!where || !date) throw new Error(`bad observation key "${key}"`);
  if (category === 0) {
    return { tool: "get_flight_delay", args: { eventId, flight: where, date } };
  }
  const [lat, lon] = where.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`bad coordinates "${key}"`);
  return { tool: "get_rainfall_24h", args: { eventId, lat, lon, date } };
}

/** The key a source uses to look up ground truth, rebuilt from tool arguments. */
export function observationKeyFromArgs(tool: ToolName, args: Record<string, unknown>): string {
  if (tool === "get_flight_delay") return `${String(args.flight)}|${String(args.date)}`;
  return `${String(args.lat)},${String(args.lon)}|${String(args.date)}`;
}
