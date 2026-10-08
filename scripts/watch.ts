/**
 * Live terminal view of the local chain: every transaction to the TIES contracts with the block,
 * the sender's role and nonce, the decoded call, its events and gas, plus what each oracle node is
 * doing off chain (fetching from its source over MCP, committing, revealing).
 *
 *   npm run watch               everything
 *   npm run watch -- --oracles  oracle rounds only (rounds, commits, reveals, results, escalations)
 *
 * Read-only: it sends nothing. It follows a redeploy (Presenter reset) by itself.
 */
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Result,
  TransactionResponse,
  formatEther,
} from "ethers";
import {
  ACCOUNTS,
  DeploymentWatcher,
  PORTS,
  SOURCES,
  connectContracts,
  defaultChainId,
  defaultRpcUrl,
  describeError,
  hardhatAccount,
  makeProvider,
  sleep,
  type Deployment,
  type TiesContracts,
} from "../services/shared/src";
import { loadNodeConfig } from "./lib/seed";

const ORACLES_ONLY = process.argv.includes("--oracles");
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2);
const bold = paint(1);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const blue = paint(34);
const magenta = paint(35);
const cyan = paint(36);

const WAD = 10n ** 18n;
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const eth = (wei: bigint) =>
  `${Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`;
const wad = (v: bigint, dp = 2) => (Number(v) / 1e18).toFixed(dp);
const gasText = (g: bigint) => `${Number(g).toLocaleString("en-US")} gas`;
const STATUS = ["NONE", "ROUND_COMMIT", "ROUND_REVEAL", "DEFAULT_PENDING", "DISPUTED", "FINAL"];
const OUTCOME = ["INSUFFICIENT", "VALID", "DISPUTED"];
const REASON = ["inconsistent evidence", "challenged default", "evidence never sufficient"];

// ----------------------------------------------------------------- who is who

const nodes = loadNodeConfig();
const labels = new Map<string, string>();
const oracleAddresses = new Set<string>();
{
  const put = (i: number, label: string) => {
    const a = hardhatAccount(i).address.toLowerCase();
    labels.set(a, labels.has(a) ? `${labels.get(a)}/${label}` : label);
  };
  put(ACCOUNTS.admin, "admin #0");
  ACCOUNTS.lps.forEach((i, n) => put(i, `LP${n + 1} #${i}`));
  ACCOUNTS.holders.forEach((i, n) => put(i, `holder${n + 1} #${i}`));
  put(ACCOUNTS.keeper, "keeper #9");
  put(ACCOUNTS.challenger, "challenger #18");
  const byAccount = new Map<number, string[]>();
  for (const n of nodes) {
    byAccount.set(n.account, [...(byAccount.get(n.account) ?? []), `${n.id}→S${n.sourceId}`]);
    oracleAddresses.add(hardhatAccount(n.account).address.toLowerCase());
  }
  for (const [account, ids] of byAccount) put(account, `oracle ${ids.join(",")} #${account}`);
}
const who = (a: string | null | undefined) => (a ? (labels.get(a.toLowerCase()) ?? short(a)) : "?");
const sourceName = (id: number | bigint) => {
  const s = SOURCES.find((x) => x.id === Number(id));
  return s ? `S${s.id} ${s.name}` : `S${id}`;
};

// ------------------------------------------------------------------- chain side

class ChainView {
  private contracts?: TiesContracts;
  private byAddress = new Map<string, { name: string; iface: Interface }>();
  private ifaces: Interface[] = [];
  private units = new Map<number, string>();

  constructor(
    private readonly provider: JsonRpcProvider,
    d: Deployment,
  ) {
    this.contracts = connectContracts(d, provider);
    const c = this.contracts;
    const named: [string, Contract][] = [
      ["Vault", c.vault],
      ["TIESRegistry", c.registry],
      ["PolicyBook", c.book],
      ["SettlementEngine", c.engine],
    ];
    for (const [name, k] of named) {
      const address = (k.target as string).toLowerCase();
      this.byAddress.set(address, { name, iface: k.interface });
      this.ifaces.push(k.interface);
    }
  }

  private async unit(eventId: bigint): Promise<string> {
    const id = Number(eventId);
    if (!this.units.has(id)) {
      try {
        const e = await this.contracts!.book.eventData(eventId);
        this.units.set(id, Number(e.category) === 1 ? "mm" : "min");
      } catch {
        return "";
      }
    }
    return this.units.get(id)!;
  }

  private async milli(v: bigint, eventId: bigint) {
    return `${(Number(v) / 1000).toFixed(1)} ${await this.unit(eventId)}`;
  }

  async block(n: number): Promise<void> {
    const b = await this.provider.getBlock(n, true);
    if (!b) return;
    const ours = b.prefetchedTransactions.filter(
      (t) => t.to && this.byAddress.has(t.to.toLowerCase()),
    );
    const lines: string[] = [];
    for (const tx of ours) lines.push(...(await this.tx(tx)));
    if (!lines.length) return;
    const time = new Date(b.timestamp * 1000).toLocaleTimeString();
    console.log(dim(`── block ${b.number} · chain time ${time} ${"─".repeat(40)}`));
    for (const l of lines) console.log(l);
  }

  private async tx(tx: TransactionResponse): Promise<string[]> {
    const target = this.byAddress.get(tx.to!.toLowerCase())!;
    const receipt = await this.provider.getTransactionReceipt(tx.hash);
    let call = `${target.name}.?`;
    try {
      const parsed = target.iface.parseTransaction({ data: tx.data, value: tx.value });
      if (parsed) {
        call = `${target.name}.${parsed.name}(${parsed.args
          .map((a) => (typeof a === "bigint" && a > 10n ** 15n ? eth(a) : String(a).slice(0, 18)))
          .join(", ")})`;
      }
    } catch {
      /* unknown selector */
    }
    const fromOracle = oracleAddresses.has(tx.from.toLowerCase());
    const engineCall = target.name === "SettlementEngine";
    if (ORACLES_ONLY && !fromOracle && !engineCall) return [];

    const ok = receipt?.status === 1;
    const tag = fromOracle ? magenta("ORACLE") : engineCall ? cyan("ENGINE") : blue("TX    ");
    const head =
      `${tag} ${bold(who(tx.from))} ${dim(`nonce ${tx.nonce}`)}  ${call}` +
      `  ${dim(receipt ? gasText(receipt.gasUsed) : "")} ${ok ? green("✔") : red("✘ reverted")}` +
      dim(`  ${short(tx.hash)}`);
    const out = [head];
    if (!ok) out.push(red(`         ${await this.revertReason(tx)}`));
    for (const log of receipt?.logs ?? []) {
      const src = this.byAddress.get(log.address.toLowerCase());
      if (!src) continue;
      let ev;
      try {
        ev = src.iface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        ev = null;
      }
      if (!ev) continue;
      const text = await this.event(ev.name, ev.args);
      if (text) out.push(`         ${text}`);
    }
    return out;
  }

  private async revertReason(tx: TransactionResponse): Promise<string> {
    try {
      await this.provider.call({ ...tx, blockTag: (tx.blockNumber ?? 1) - 1 });
      return "reverted";
    } catch (err) {
      return describeError(this.ifaces, err);
    }
  }

  private async event(name: string, a: Result): Promise<string | null> {
    switch (name) {
      case "RoundOpened": {
        const nonces = await Promise.all(
          (a.committee as string[]).map(
            async (m) => `${who(m)} next nonce ${await this.provider.getTransactionCount(m)}`,
          ),
        );
        return (
          yellow(
            `round ${a.round} opened for event ${a.eventId}: commit by ${new Date(Number(a.commitDeadline) * 1000).toLocaleTimeString()}, reveal by ${new Date(Number(a.revealDeadline) * 1000).toLocaleTimeString()}`,
          ) + `\n           committee: ${nonces.join(" · ")}`
        );
      }
      case "ReportCommitted":
        return `commit stored for ${who(a.oracle)} (event ${a.eventId}, round ${a.round}); the value stays hidden until the reveal`;
      case "ReportRevealed":
        return green(
          `revealed ${await this.milli(a.value, a.eventId)} · source ${sourceName(a.sourceId)} recovered from the signature`,
        );
      case "RoundFinalized": {
        const status = OUTCOME[Number(a.status)];
        const hasL = a.U < 10n ** 60n;
        const iv = hasL
          ? `[${await this.milli(a.L, a.eventId)}, ${await this.milli(a.U, a.eventId)}]`
          : "none yet";
        const tone = status === "VALID" ? green : status === "DISPUTED" ? red : yellow;
        return (
          tone(
            `round ${a.round} ${status}: V ${await this.milli(a.V, a.eventId)}, σ ${(Number(a.sigma) / 1000).toFixed(2)}, N_eff ${wad(a.nEff)}, interval ${iv}`,
          ) +
          `\n           pay up to bucket ${a.payCursor}, no pay from ${a.noPayCursor}; newly claimable ${eth(a.newPay)}, released ${eth(a.newNoPay)}, still held ${eth(a.held)}`
        );
      }
      case "EscalationRequested":
        return yellow(
          `escalation: held ${eth(a.held)}, recruiting ${(a.selected as string[]).map(who).join(", ") || "nobody"} for round ${a.nextRound}`,
        );
      case "EventStatusChanged":
        return ORACLES_ONLY ? null : dim(`event ${a.eventId} → ${STATUS[Number(a.status)]}`);
      case "EventDefaultPending":
        return yellow(
          `event ${a.eventId}: no further round; default after ${new Date(Number(a.challengeDeadline) * 1000).toLocaleTimeString()} unless challenged`,
        );
      case "EventChallenged":
        return red(`event ${a.eventId} challenged by ${who(a.challenger)} with ${eth(a.bond)}`);
      case "EventDisputed":
        return red(
          `event ${a.eventId} DISPUTED (${REASON[Number(a.reason)]}); waiting for the admin`,
        );
      case "DefaultApplied":
        return yellow(`default applied at ${await this.milli(a.value, a.eventId)}`);
      case "DisputeResolved":
        return yellow(`dispute resolved at ${await this.milli(a.finalValue, a.eventId)}`);
      case "EventFinalized":
        return green(
          bold(`event ${a.eventId} FINAL at ${await this.milli(a.finalValue, a.eventId)}`),
        );
      case "ReputationUpdated":
        return dim(`reputation ${who(a.oracle)} → ${wad((a.alpha * WAD) / (a.alpha + a.beta))}`);
      case "DependenceUpdated":
        return dim(
          `dependence ${sourceName(a.sourceA)} ~ ${sourceName(a.sourceB)} → ${wad(a.rho)}`,
        );
      case "LearningSkipped":
        return red(`learning update skipped for event ${a.eventId}`);
      case "PolicyBound":
        return `policy #${a.policyId} on event ${a.eventId}: pays ${eth(a.payout)} if ≥ ${a.bucket}, premium ${eth(a.premium)}`;
      case "Claimed":
        return green(`policy #${a.policyId} paid ${eth(a.amount)} to ${who(a.holder)}`);
      case "Deposit":
        return `${who(a.lp)} deposited ${eth(a.assets)}`;
      case "Withdraw":
        return `${who(a.lp)} withdrew ${eth(a.assets)}`;
      case "EventCreated":
        return `event ${a.eventId} created: ${a.label}`;
      case "BondOwed":
        return yellow(`bond of ${eth(a.amount)} kept for ${who(a.challenger)} to withdraw`);
      default:
        return ORACLES_ONLY ? null : dim(name);
    }
  }
}

// ------------------------------------------------------------------ oracle side

interface NodeStatus {
  id: string;
  sourceId: number;
  mode: string;
  running: boolean;
  tasks: { eventId: number; round: number; state: string; value?: string; error?: string }[];
}

const STATE_TEXT: Record<string, string> = {
  pending: "is on the committee, waiting to fetch",
  fetching: "calls its source over MCP",
  committed: "committed (value hidden)",
  revealed: "revealed",
  silent: "stays silent (mode silent): no reveal",
  missed: "missed the commit window",
  expired: "round closed before it acted",
  failed: "failed",
  reveal_failed: "reveal failed",
};

async function pollNodes(seen: Map<string, string>): Promise<void> {
  let status: { nodes: NodeStatus[] };
  try {
    const r = await fetch(`http://127.0.0.1:${PORTS.oracleNode}/status`);
    status = (await r.json()) as { nodes: NodeStatus[] };
  } catch {
    return;
  }
  for (const n of status.nodes) {
    for (const t of n.tasks) {
      const key = `${n.id}:${t.eventId}:${t.round}`;
      if (seen.get(key) === t.state) continue;
      seen.set(key, t.state);
      const value =
        t.value && (t.state === "committed" || t.state === "revealed")
          ? ` ${Number(t.value) / 1000}`
          : "";
      const mode = n.mode !== "honest" ? red(` [${n.mode}]`) : "";
      const err = t.error ? red(` — ${t.error}`) : "";
      const tone = /failed|missed|silent|expired/.test(t.state) ? red : magenta;
      console.log(
        `${tone("NODE  ")} ${bold(n.id)} ${dim(`(${sourceName(n.sourceId)})`)}${mode} event ${t.eventId} round ${t.round}: ${STATE_TEXT[t.state] ?? t.state}${value}${err}`,
      );
    }
  }
}

// ------------------------------------------------------------------------ main

async function main(): Promise<void> {
  const chainId = defaultChainId();
  const provider = makeProvider(defaultRpcUrl(), chainId);
  const deployments = new DeploymentWatcher(chainId);
  console.log(
    bold(
      `TIES live view · ${defaultRpcUrl()} · ${ORACLES_ONLY ? "oracle rounds only" : "all transactions"}`,
    ),
  );
  console.log(
    dim(
      "ORACLE = oracle key on chain · NODE = oracle node off chain · ENGINE = settlement call · Ctrl+C to stop\n",
    ),
  );
  let view: ChainView | null = null;
  let version = -1;
  let last = -1;
  const seen = new Map<string, string>();
  for (;;) {
    try {
      const d = deployments.current();
      if (d && deployments.version !== version) {
        version = deployments.version;
        view = new ChainView(provider, d);
        console.log(
          bold(
            `watching deployment from block ${d.deployBlock} (engine ${short(d.addresses.engine)})`,
          ),
        );
        seen.clear();
        if (last < 0) last = (await provider.getBlockNumber()) - 1;
      }
      const head = await provider.getBlockNumber();
      if (head < last) last = head - 1; // the chain restarted
      while (view && last < head) {
        last += 1;
        await view.block(last);
      }
      await pollNodes(seen);
    } catch (err) {
      console.log(
        red(`(waiting for the chain: ${err instanceof Error ? err.message.split("\n")[0] : err})`),
      );
      await sleep(2000);
    }
    await sleep(400);
  }
}

void main();
