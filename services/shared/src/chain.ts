import { JsonRpcProvider, Network } from "ethers";
import { PORTS } from "./topology";

export const defaultRpcUrl = () => process.env.RPC_URL ?? `http://127.0.0.1:${PORTS.rpc}`;
export const defaultChainId = () => Number(process.env.CHAIN_ID ?? 31337);

/** A provider with a fixed network, so it does not spam retries while the node is still starting. */
export function makeProvider(
  rpcUrl = defaultRpcUrl(),
  chainId = defaultChainId(),
): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: Network.from(chainId),
    batchMaxCount: 1,
    cacheTimeout: -1,
    pollingInterval: 500,
  });
}

/** Timestamp of the latest mined block (the chain's notion of "now"). */
export async function chainNow(provider: JsonRpcProvider): Promise<number> {
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("no latest block");
  return block.timestamp;
}

/** Waits until the node answers, e.g. while `hardhat node` is starting. */
export async function waitForRpc(provider: JsonRpcProvider, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error("RPC node did not come up in time");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

type ErrorDecoder = { parseError(data: string): { name: string; args: unknown } | null };

/** The decoded custom error of a failed call, or null if the ABI does not know it. */
export function decodeCustomError(iface: ErrorDecoder, err: unknown): string | null {
  const e = err as { data?: string; shortMessage?: string; message?: string };
  const candidates: string[] = [];
  if (typeof e?.data === "string") candidates.push(e.data);
  const nested = (e as { error?: { data?: string | { data?: string } } })?.error?.data;
  if (typeof nested === "string") candidates.push(nested);
  else if (nested && typeof nested.data === "string") candidates.push(nested.data);
  const message = e?.shortMessage ?? e?.message ?? String(err);
  candidates.push(...(message.match(/0x[0-9a-fA-F]{8,}/g) ?? []));
  try {
    candidates.push(...(JSON.stringify(err).match(/0x[0-9a-fA-F]{8,}/g) ?? []));
  } catch {
    // circular structure: the message above is all we have
  }
  for (const data of candidates) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) {
        const args = Array.isArray(parsed.args) ? parsed.args.map(String).join(", ") : "";
        return `${parsed.name}(${args})`;
      }
    } catch {
      // not a known custom error
    }
  }
  return null;
}

/** Short readable reason for a failed call: the decoded custom error if any ABI knows it. */
export function describeError(iface: ErrorDecoder | ErrorDecoder[], err: unknown): string {
  for (const i of Array.isArray(iface) ? iface : [iface]) {
    const decoded = decodeCustomError(i, err);
    if (decoded) return decoded;
  }
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(err)).split(/\r?\n/)[0];
}
