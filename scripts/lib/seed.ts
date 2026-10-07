import { Contract, JsonRpcProvider, parseEther } from "ethers";
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNTS,
  Deployment,
  SOURCES,
  chainNow,
  connectContracts,
  ensureSourceKeys,
  hardhatSigner,
  makeLogger,
  repoRoot,
  toolHashOf,
} from "../../services/shared/src";
import { Wallet } from "ethers";

const log = makeLogger("seed");

export interface NodeConfig {
  id: string;
  account: number;
  category: number;
  sourceId: number;
  primary: boolean;
  mode: "honest" | "tamper" | "silent" | "late";
}

export function loadNodeConfig(): NodeConfig[] {
  const file = path.join(repoRoot(), "services", "oracle-node", "nodes.json");
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { nodes: NodeConfig[] }).nodes;
}

export interface SeedEvent {
  category: number;
  label: string;
  key: string;
  policies: { holder: number; bucket: number; payout: string }[];
}

/** Demo events (CLAUDE.md section 6, M4): three flights and one rainfall event on a real past date. */
export const DEMO_EVENTS: SeedEvent[] = [
  {
    category: 0,
    label: "AI 101 DEL-BOM 2026-10-12",
    key: "AI101|2026-10-12",
    policies: [
      { holder: 4, bucket: 60, payout: "1" },
      { holder: 5, bucket: 120, payout: "2" },
      { holder: 6, bucket: 130, payout: "2" },
      { holder: 7, bucket: 150, payout: "1" },
    ],
  },
  {
    category: 0,
    label: "6E 2231 BLR-HYD 2026-10-12",
    key: "6E2231|2026-10-12",
    policies: [
      { holder: 4, bucket: 30, payout: "1" },
      { holder: 5, bucket: 45, payout: "1" },
    ],
  },
  {
    category: 0,
    label: "UK 811 BOM-MAA 2026-10-13",
    key: "UK811|2026-10-13",
    policies: [{ holder: 6, bucket: 90, payout: "1.5" }],
  },
  {
    category: 1,
    label: "Chennai 24h rainfall 2025-10-22",
    key: "13.08,80.27|2025-10-22",
    policies: [
      { holder: 7, bucket: 10, payout: "1" },
      { holder: 8, bucket: 25, payout: "1" },
    ],
  },
];

export interface SeedOptions {
  events?: boolean;
  lpDeposit?: string;
}

/** Registers sources and oracles, funds the vault and creates the demo events. */
export async function seedAll(
  provider: JsonRpcProvider,
  deployment: Deployment,
  opts: SeedOptions = {},
): Promise<void> {
  const admin = hardhatSigner(ACCOUNTS.admin, provider);
  const c = connectContracts(deployment, admin);
  const send = async (tx: Promise<{ wait(): Promise<unknown> }>) => (await tx).wait();

  // Sources, in the order of the topology so registry ids equal S-numbers.
  const keys = ensureSourceKeys();
  for (const s of SOURCES) {
    await send(
      c.registry.registerSource(new Wallet(keys[s.key]).address, s.category, s.name, [
        toolHashOf(s.tool),
      ]),
    );
  }
  log.info(`registered ${SOURCES.length} sources`);

  for (const n of loadNodeConfig()) {
    const address = await hardhatSigner(n.account, provider).getAddress();
    await send(c.registry.registerOracle(address, n.category, n.sourceId, n.primary));
  }
  log.info("registered oracle keys");

  const each = parseEther(opts.lpDeposit ?? "10");
  for (const index of ACCOUNTS.lps) {
    const vault = c.vault.connect(hardhatSigner(index, provider)) as Contract;
    await send(vault.deposit({ value: each }));
  }
  log.info(`LPs deposited ${3n * each} wei`);

  if (opts.events === false) return;
  await seedEvents(provider, deployment);
}

/** Creates the demo events with a few policies each (the vault must already hold liquidity). */
export async function seedEvents(provider: JsonRpcProvider, deployment: Deployment): Promise<void> {
  const admin = hardhatSigner(ACCOUNTS.admin, provider);
  const c = connectContracts(deployment, admin);
  const send = async (tx: Promise<{ wait(): Promise<unknown> }>) => (await tx).wait();
  const now = await chainNow(provider);
  for (const ev of DEMO_EVENTS) {
    await send(c.book.createEvent(ev.category, ev.label, ev.key, now + 3600, now + 7200));
    const eventId = await c.book.eventCount();
    for (const p of ev.policies) {
      const book = c.book.connect(hardhatSigner(p.holder, provider)) as Contract;
      const payout = parseEther(p.payout);
      const premium = (await c.book.quote(eventId, p.bucket, payout)) as bigint;
      await send(book.bind(eventId, p.bucket, payout, { value: premium }));
    }
    log.info(`event ${eventId} "${ev.label}" with ${ev.policies.length} policies`);
  }
}
