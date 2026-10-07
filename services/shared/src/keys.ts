import {
  HDNodeWallet,
  JsonRpcProvider,
  TransactionRequest,
  TransactionResponse,
  Wallet,
} from "ethers";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths";
import { HARDHAT_MNEMONIC, SOURCES } from "./topology";

/** The Hardhat dev account `index` (no provider attached). */
export function hardhatAccount(index: number): HDNodeWallet {
  return HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, "", `m/44'/60'/0'/0/${index}`);
}

/**
 * A wallet that sends one transaction at a time and reads its nonce from the node before each
 * send. Unlike the ethers NonceManager it cannot drift when a send fails (for example a reveal
 * that reverts), which matters because several services reuse the same keys.
 */
export class SerialWallet extends Wallet {
  private queue: Promise<unknown> = Promise.resolve();

  override sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const run = this.queue.then(async () => {
      const nonce = await this.provider!.getTransactionCount(this.address, "pending");
      return super.sendTransaction({ ...tx, nonce });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** A signer for a Hardhat dev account, connected to `provider`. */
export function hardhatSigner(index: number, provider: JsonRpcProvider): SerialWallet {
  return new SerialWallet(hardhatAccount(index).privateKey, provider);
}

export const keysFile = () => path.join(repoRoot(), "services", ".keys", "sources.json");

/**
 * Source signer keys live in `services/.keys/sources.json` (gitignored). They are generated once
 * and reused, so the seed script and the source servers always agree.
 */
export function ensureSourceKeys(): Record<string, string> {
  const file = keysFile();
  const read = (): Record<string, string> | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
      return SOURCES.every((s) => parsed[s.key]) ? parsed : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  const keys: Record<string, string> = {};
  for (const s of SOURCES) keys[s.key] = Wallet.createRandom().privateKey;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify(keys, null, 2), { flag: "wx" });
    return keys;
  } catch {
    // another process created it first
    const winner = read();
    if (winner) return winner;
    throw new Error(`could not create ${file}`);
  }
}

export function sourceWallet(key: string): Wallet {
  const keys = ensureSourceKeys();
  if (!keys[key]) throw new Error(`no signer key for source ${key}`);
  return new Wallet(keys[key]);
}
