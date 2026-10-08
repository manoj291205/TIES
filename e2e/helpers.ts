import fs from "node:fs";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { Contract, JsonRpcProvider, formatEther } from "ethers";

export const ROOT = path.resolve(__dirname, "..");
export const DEMO = "http://127.0.0.1:7000";
export const RPC = "http://127.0.0.1:8545";

/** Hardhat development accounts used by the demo (public keys, local chain only). */
export const ACCOUNT = {
  admin: 0,
  lp: 1,
  holder: 4,
  holder2: 5,
  oracleN1: 10,
  challenger: 18,
  spare: 19,
} as const;

export async function demo<T = unknown>(
  method: "GET" | "POST",
  p: string,
  body?: unknown,
): Promise<T> {
  const r = await fetch(DEMO + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

let accountsCache: { index: number; address: string }[] | null = null;
export async function address(index: number): Promise<string> {
  accountsCache ??= await demo<{ index: number; address: string }[]>("GET", "/accounts");
  const hit = accountsCache.find((a) => a.index === index);
  if (hit) return hit.address;
  // Indexes the demo server does not list (e.g. #19) come from the node's own account list.
  const all = (await provider.send("eth_accounts", [])) as string[];
  return all[index];
}

export const provider = new JsonRpcProvider(RPC, 31337, { cacheTimeout: -1 });

/** Contracts of the current deployment (re-read after every reset). */
export function chain() {
  const d = JSON.parse(
    fs.readFileSync(path.join(ROOT, "frontend/src/contracts/deployments/31337.json"), "utf8"),
  ) as { addresses: Record<string, string> };
  const abi = (n: string) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, `frontend/src/contracts/abi/${n}.json`), "utf8"));
  return {
    engine: new Contract(d.addresses.engine, abi("SettlementEngine"), provider),
    book: new Contract(d.addresses.book, abi("PolicyBook"), provider),
    vault: new Contract(d.addresses.vault, abi("Vault"), provider),
    registry: new Contract(d.addresses.registry, abi("TIESRegistry"), provider),
  };
}

export const ethOf = (wei: bigint) => Number(formatEther(wei));

export async function chainTime(): Promise<number> {
  return (await provider.getBlock("latest"))!.timestamp;
}

/** Moves chain time to just past `target` (a unix timestamp). */
export async function advanceTo(target: number): Promise<void> {
  const now = await chainTime();
  if (target >= now) await demo("POST", "/time/advance", { seconds: target - now + 2 });
}

/** Polls `fn` until it returns a truthy value. */
export async function until<T>(fn: () => Promise<T>, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${String(last)})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export const STATUS = { NONE: 0, COMMIT: 1, REVEAL: 2, DEFAULT_PENDING: 3, DISPUTED: 4, FINAL: 5 };
export async function eventStatus(eventId: number): Promise<number> {
  return Number((await chain().engine.eventState(eventId)).status);
}

/**
 * An EIP-1193 provider shaped like MetaMask that signs as `account` through the unlocked Hardhat
 * node. `chainHex` is the chain the wallet starts on; `connected: false` makes eth_accounts empty
 * until eth_requestAccounts, as a fresh MetaMask would.
 */
function walletScript(o: {
  account: string | null;
  theme: string;
  chainHex: string;
  connected: boolean;
}) {
  return `(() => {
    try { localStorage.setItem("ties.theme", ${JSON.stringify(o.theme)}); } catch {}
    const ACCOUNT = ${JSON.stringify(o.account)};
    if (!ACCOUNT) return;
    let chain = ${JSON.stringify(o.chainHex)};
    let connected = ${o.connected};
    let id = 0;
    const listeners = {};
    const emit = (e, v) => (listeners[e] || []).forEach((f) => f(v));
    const rpc = async (method, params) => {
      const r = await fetch(${JSON.stringify(RPC)}, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params || [] }) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
      return j.result;
    };
    window.__wallet = { calls: [] };
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        window.__wallet.calls.push(method);
        switch (method) {
          case "eth_accounts": return connected ? [ACCOUNT] : [];
          case "eth_requestAccounts": connected = true; emit("accountsChanged", [ACCOUNT]); return [ACCOUNT];
          case "eth_chainId": return chain;
          case "net_version": return String(parseInt(chain, 16));
          case "wallet_switchEthereumChain":
            if (params[0].chainId !== "0x7a69") { const e = new Error("Unrecognized chain"); e.code = 4902; throw e; }
            chain = params[0].chainId; emit("chainChanged", chain); return null;
          case "wallet_addEthereumChain": chain = params[0].chainId; emit("chainChanged", chain); return null;
          case "eth_sendTransaction":
            if (chain !== "0x7a69") throw new Error("wallet is on another chain");
            return rpc(method, [{ ...params[0], from: ACCOUNT }]);
          default: return rpc(method, params);
        }
      },
      on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); },
      removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
    };
  })();`;
}

export interface OpenOptions {
  theme?: "light" | "dark";
  chainHex?: string;
  connected?: boolean;
  width?: number;
}

export interface OpenedPage {
  page: Page;
  errors: string[];
  close: () => Promise<void>;
}

/** Opens `route` in a fresh browser context with a wallet for Hardhat account `index` (null: none). */
export async function openAs(
  browser: Browser,
  index: number | null,
  route: string,
  opts: OpenOptions = {},
): Promise<OpenedPage> {
  const account = index === null ? null : await address(index);
  const ctx = await browser.newContext({
    viewport: { width: opts.width ?? 1440, height: 900 },
    baseURL: "http://localhost:5173",
  });
  await ctx.addInitScript({
    content: walletScript({
      account,
      theme: opts.theme ?? "light",
      chainHex: opts.chainHex ?? "0x7a69",
      connected: opts.connected ?? true,
    }),
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.goto(`/#/${route}`);
  await expect(page.locator("h1").first()).toBeVisible();
  return { page, errors, close: () => ctx.close() };
}

/** Fails the test if the page logged errors (ignoring the browser's own resource noise). */
export function expectNoErrors(o: OpenedPage): void {
  const real = o.errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED.*7109/.test(e));
  expect(real, real.join("\n")).toEqual([]);
}

/** Waits for the most recent transaction panel or toast to report a mined transaction. */
export async function expectConfirmed(page: Page): Promise<void> {
  await expect(page.getByText(/Confirmed on-chain|confirmed/i).first()).toBeVisible({
    timeout: 30_000,
  });
}
