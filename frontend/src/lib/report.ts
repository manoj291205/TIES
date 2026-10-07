import { AbiCoder, keccak256 } from "ethers";

/** Arguments of a source tool call, from an event's observation key ("AI101|2026-10-12"). */
export function toolArgs(
  category: number,
  key: string,
  eventId: number,
): Record<string, string | number> {
  const [where, date] = key.split("|");
  if (category === 0) return { eventId, flight: where, date };
  const [lat, lon] = where.split(",").map(Number);
  return { eventId, lat, lon, date };
}

export interface StoredReport {
  value: string;
  ts: number;
  toolHash: string;
  argsHash: string;
  responseHash: string;
  signature: string;
  salt: string;
}

/** keccak256(abi.encode(value, ts, toolHash, argsHash, responseHash, sourceSig, salt, sender)). */
export function commitHashOf(r: StoredReport, sender: string): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "bytes32", "bytes32", "bytes32", "bytes", "bytes32", "address"],
      [BigInt(r.value), r.ts, r.toolHash, r.argsHash, r.responseHash, r.signature, r.salt, sender],
    ),
  );
}

export const randomSalt = (): string => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

const storeKey = (chain: number, eventId: number, round: number, account: string) =>
  `ties.commit.${chain}.${eventId}.${round}.${account.toLowerCase()}`;

export function saveReport(
  chain: number,
  eventId: number,
  round: number,
  account: string,
  r: StoredReport,
) {
  try {
    localStorage.setItem(storeKey(chain, eventId, round, account), JSON.stringify(r));
  } catch {
    /* storage unavailable: the operator is warned in the UI */
  }
}

export function loadReport(
  chain: number,
  eventId: number,
  round: number,
  account: string,
): StoredReport | null {
  try {
    const raw = localStorage.getItem(storeKey(chain, eventId, round, account));
    return raw ? (JSON.parse(raw) as StoredReport) : null;
  } catch {
    return null;
  }
}
