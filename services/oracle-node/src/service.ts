import { Contract, JsonRpcProvider } from "ethers";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  ACCOUNTS,
  Deployment,
  DeploymentWatcher,
  HttpError,
  Logger,
  PORTS,
  SOURCES,
  TiesContracts,
  chainNow,
  commitHashOf,
  connectContracts,
  defaultChainId,
  defaultRpcUrl,
  describeError,
  errorMessage,
  handlePreflight,
  hardhatSigner,
  type SerialWallet,
  makeLogger,
  makeProvider,
  parseObservationKey,
  randomSalt,
  readBody,
  sendJson,
  sleep,
  type SignedReport,
} from "../../shared/src";
import { fetchSignedReport } from "./mcpClient";

export type NodeMode = "honest" | "tamper" | "silent" | "late";
const MODES: NodeMode[] = ["honest", "tamper", "silent", "late"];

export interface NodeConfig {
  id: string;
  account: number;
  category: number;
  sourceId: number;
  primary: boolean;
  mode: NodeMode;
}

type TaskState =
  | "pending"
  | "fetching"
  | "committed"
  | "revealed"
  | "silent"
  | "missed"
  | "expired"
  | "failed"
  | "reveal_failed";

interface Task {
  nodeId: string;
  eventId: number;
  round: number;
  state: TaskState;
  error?: string;
  value?: string;
  commitTx?: string;
  revealTx?: string;
  busy: boolean;
  report?: SignedReport;
  salt?: string;
  commitHash?: string;
  /** Value actually committed (differs from the signed one in tamper mode). */
  committedValue?: bigint;
}

interface OpenRound {
  eventId: number;
  round: number;
  committee: string[];
}

const TERMINAL: TaskState[] = [
  "revealed",
  "silent",
  "missed",
  "expired",
  "failed",
  "reveal_failed",
];

export function loadNodes(file = path.join(__dirname, "..", "nodes.json")): NodeConfig[] {
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { nodes: NodeConfig[] }).nodes;
}

export class OracleService {
  private readonly nodes: NodeConfig[];
  private readonly running = new Map<string, boolean>();
  private readonly signers = new Map<number, SerialWallet>();
  private readonly addresses = new Map<number, string>();
  private tasks: Task[] = [];
  private rounds = new Map<string, OpenRound>();
  private contracts?: TiesContracts;
  private fromBlock = 0;
  private seenVersion = -1;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private server?: http.Server;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly deployments: DeploymentWatcher,
    private readonly log: Logger,
    nodes: NodeConfig[] = loadNodes(),
    private readonly sourcePort: (sourceId: number) => number = (id) =>
      SOURCES.find((s) => s.id === id)!.port,
  ) {
    this.nodes = nodes.map((n) => ({ ...n }));
    for (const n of this.nodes) this.running.set(n.id, true);
  }

  private signerFor(account: number): SerialWallet {
    let s = this.signers.get(account);
    if (!s) {
      s = hardhatSigner(account, this.provider);
      this.signers.set(account, s);
    }
    return s;
  }

  async start(pollMs = 400): Promise<void> {
    for (const n of this.nodes) {
      this.addresses.set(n.account, await this.signerFor(n.account).getAddress());
    }
    this.timer = setInterval(() => void this.tick(), pollMs);
    this.log.info(`managing ${this.nodes.length} oracle nodes on ${this.addresses.size} keys`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.server?.closeAllConnections();
    this.server?.close();
  }

  status() {
    return {
      deployed: this.contracts !== undefined,
      nodes: this.nodes.map((n) => ({
        ...n,
        address: this.addresses.get(n.account),
        running: this.running.get(n.id) === true,
        tasks: this.tasks
          .filter((t) => t.nodeId === n.id)
          .map(({ busy: _busy, report: _report, salt: _salt, ...t }) => t),
      })),
    };
  }

  setMode(id: string, mode: string): void {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) throw new HttpError(404, `unknown node ${id}`);
    if (!MODES.includes(mode as NodeMode)) {
      throw new HttpError(400, `mode must be one of ${MODES.join(", ")}`);
    }
    node.mode = mode as NodeMode;
    this.log.info(`${id} mode -> ${mode}`);
  }

  setRunning(id: string, running: boolean): void {
    if (!this.nodes.some((n) => n.id === id)) throw new HttpError(404, `unknown node ${id}`);
    this.running.set(id, running);
    this.log.info(`${id} ${running ? "started" : "stopped"}`);
  }

  // ------------------------------------------------------------------------- loop

  private rebind(d: Deployment): void {
    this.contracts = connectContracts(d, this.provider);
    this.fromBlock = d.deployBlock;
    this.tasks = [];
    this.rounds = new Map();
    this.log.info(`bound to engine ${d.addresses.engine}`);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const d = this.deployments.current();
      if (!d) return;
      if (this.deployments.version !== this.seenVersion) {
        this.seenVersion = this.deployments.version;
        this.rebind(d);
      }
      await this.scan();
      await this.assign();
      await Promise.all(
        this.tasks.filter((t) => !TERMINAL.includes(t.state)).map((t) => this.advance(t)),
      );
    } catch (err) {
      this.log.warn(`tick failed: ${errorMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async scan(): Promise<void> {
    const { engine } = this.contracts!;
    const head = await this.provider.getBlockNumber();
    if (head < this.fromBlock) return;
    const logs = await engine.queryFilter(engine.filters.RoundOpened(), this.fromBlock, head);
    this.fromBlock = head + 1;
    for (const l of logs) {
      const a = (l as unknown as { args: { eventId: bigint; round: bigint; committee: string[] } })
        .args;
      const eventId = Number(a.eventId);
      const round = Number(a.round);
      this.rounds.set(`${eventId}:${round}`, {
        eventId,
        round,
        committee: a.committee.map((x) => x.toLowerCase()),
      });
    }
  }

  /** Creates a task for every running node on the committee of a round that is still open. */
  private async assign(): Promise<void> {
    const { engine, book } = this.contracts!;
    for (const r of this.rounds.values()) {
      const st = await engine.eventState(r.eventId);
      const open =
        (Number(st.status) === 1 || Number(st.status) === 2) && Number(st.round) === r.round;
      if (!open) continue;
      const category = Number((await book.eventMeta(r.eventId)).category);
      for (const n of this.nodes) {
        if (this.running.get(n.id) !== true || n.category !== category) continue;
        const address = this.addresses.get(n.account)!.toLowerCase();
        if (!r.committee.includes(address)) continue;
        if (
          this.tasks.some(
            (t) => t.nodeId === n.id && t.eventId === r.eventId && t.round === r.round,
          )
        ) {
          continue;
        }
        this.tasks.push({
          nodeId: n.id,
          eventId: r.eventId,
          round: r.round,
          state: "pending",
          busy: false,
        });
      }
    }
  }

  private async advance(task: Task): Promise<void> {
    if (task.busy) return;
    const node = this.nodes.find((n) => n.id === task.nodeId)!;
    if (this.running.get(node.id) !== true && task.state === "pending") return;
    task.busy = true;
    try {
      const { engine } = this.contracts!;
      const st = await engine.eventState(task.eventId);
      const now = await chainNow(this.provider);
      const roundOpen =
        Number(st.round) === task.round && (Number(st.status) === 1 || Number(st.status) === 2);
      if (!roundOpen) {
        task.state = task.state === "committed" ? "reveal_failed" : "expired";
        if (task.state === "reveal_failed") task.error = "round closed before the reveal";
        return;
      }
      const commitDeadline = Number(st.commitDeadline);
      const revealDeadline = Number(st.revealDeadline);

      if (task.state === "pending") {
        if (now >= commitDeadline) {
          task.state = "missed";
          task.error = "commit window already closed";
          return;
        }
        task.state = "fetching";
        await this.fetchAndCommit(task, node);
        return;
      }
      if (task.state === "committed") {
        if (node.mode === "silent") {
          task.state = "silent";
          return;
        }
        const target = node.mode === "late" ? revealDeadline : commitDeadline;
        if (now < target) return;
        await this.reveal(task, node);
      }
    } catch (err) {
      task.state = task.state === "committed" ? "reveal_failed" : "failed";
      task.error = errorMessage(err);
      this.log.warn(`${task.nodeId} event ${task.eventId} round ${task.round}: ${task.error}`);
    } finally {
      task.busy = false;
    }
  }

  private async fetchAndCommit(task: Task, node: NodeConfig): Promise<void> {
    const { engine, book } = this.contracts!;
    const key = (await book.eventData(task.eventId)).observationKey as string;
    const { tool, args } = parseObservationKey(node.category, key, task.eventId);
    const endpoint = `http://127.0.0.1:${this.sourcePort(node.sourceId)}/mcp`;
    let report: SignedReport;
    try {
      report = await fetchSignedReport(endpoint, tool, args);
    } catch (err) {
      task.state = "failed";
      task.error = `source S${node.sourceId}: ${errorMessage(err)}`;
      this.log.warn(`${task.nodeId} event ${task.eventId}: ${task.error}`);
      return;
    }
    // A tampering node alters the value after the source signed it, so the signature no longer
    // matches what it reveals.
    const signed = BigInt(report.value);
    const committedValue = node.mode === "tamper" ? signed + 5_000n : signed;
    report = { ...report, value: committedValue.toString() };
    const salt = randomSalt();
    const signer = this.signerFor(node.account);
    const hash = commitHashOf(
      { ...report, value: committedValue },
      salt,
      await signer.getAddress(),
    );
    const tx = await (engine.connect(signer) as Contract).commit(task.eventId, task.round, hash);
    task.commitTx = tx.hash;
    await tx.wait();
    task.report = report;
    task.salt = salt;
    task.value = report.value;
    task.state = "committed";
    this.log.info(
      `${task.nodeId} committed ${Number(report.value) / 1000} for event ${task.eventId} round ${task.round}`,
    );
  }

  private async reveal(task: Task, node: NodeConfig): Promise<void> {
    const { engine } = this.contracts!;
    const r = task.report!;
    const signer = this.signerFor(node.account);
    try {
      const tx = await (engine.connect(signer) as Contract).reveal(
        task.eventId,
        task.round,
        BigInt(r.value),
        r.ts,
        r.toolHash,
        r.argsHash,
        r.responseHash,
        r.signature,
        task.salt,
        { gasLimit: 900_000 },
      );
      task.revealTx = tx.hash;
      await tx.wait();
      task.state = "revealed";
      this.log.info(`${task.nodeId} revealed for event ${task.eventId} round ${task.round}`);
    } catch (err) {
      task.state = "reveal_failed";
      task.error = describeError([engine.interface, this.contracts!.verifier.interface], err);
      this.log.warn(`${task.nodeId} reveal reverted (${node.mode}): ${task.error}`);
    }
  }

  // --------------------------------------------------------------------------- http

  listen(port = PORTS.oracleNode): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        sendJson(res, status, { error: errorMessage(err) });
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.log.info(`status on http://127.0.0.1:${port}/status`);
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (handlePreflight(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/status" || url.pathname === "/health") {
      sendJson(res, 200, this.status());
      return;
    }
    const m = url.pathname.match(/^\/nodes\/([^/]+)\/(mode|start|stop)$/);
    if (m && req.method === "POST") {
      const [, id, action] = m;
      if (action === "mode") {
        const body = (await readBody(req)) as { mode?: string } | undefined;
        this.setMode(id, String(body?.mode));
      } else {
        this.setRunning(id, action === "start");
      }
      sendJson(
        res,
        200,
        this.status().nodes.find((n) => n.id === id),
      );
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }
}

export async function startOracleService(
  opts: { rpcUrl?: string; chainId?: number; port?: number; sourcePortOffset?: number } = {},
): Promise<OracleService> {
  const log = makeLogger("oracle-node");
  const provider = makeProvider(opts.rpcUrl ?? defaultRpcUrl(), opts.chainId ?? defaultChainId());
  const service = new OracleService(
    provider,
    new DeploymentWatcher(opts.chainId ?? defaultChainId()),
    log,
    loadNodes(),
    (id) => SOURCES.find((s) => s.id === id)!.port + (opts.sourcePortOffset ?? 0),
  );
  await service.start();
  await service.listen(opts.port);
  return service;
}

export { sleep, ACCOUNTS };
