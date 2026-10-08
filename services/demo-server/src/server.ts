import { JsonRpcProvider, getAddress, isAddress } from "ethers";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNTS,
  DeploymentWatcher,
  HttpError,
  Logger,
  PORTS,
  SOURCES,
  chainNow,
  defaultChainId,
  defaultRpcUrl,
  errorMessage,
  getJson,
  handlePreflight,
  hardhatAccount,
  makeLogger,
  makeProvider,
  postJson,
  readBody,
  repoRoot,
  sendJson,
  sseHeaders,
  sseSend,
} from "../../shared/src";
import { SCENARIOS } from "../../../experiments/scenarios";
import { deployAndSeed } from "../../../scripts/lib/stack";
import { seedEvents } from "../../../scripts/lib/seed";
import { RunnerUrls, ScenarioRunner, defaultUrls } from "./runner";
import { spawn } from "node:child_process";

/** Localhost-only presenter API (REST + server-sent events). Only serves the local dev chain. */
export class DemoServer {
  private server?: http.Server;
  private readonly runner: ScenarioRunner;
  private running: string | null = null;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly deployments: DeploymentWatcher,
    private readonly log: Logger,
    private readonly urls: RunnerUrls = defaultUrls(),
  ) {
    this.runner = new ScenarioRunner(provider, deployments, log, urls);
  }

  async listen(port = PORTS.demoServer): Promise<void> {
    const chainId = Number((await this.provider.getNetwork()).chainId);
    if (chainId !== 31337) throw new Error(`demo server only runs on chain 31337, not ${chainId}`);
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (res.headersSent) {
          sseSend(res, "error", { message: errorMessage(err) });
          res.end();
        } else sendJson(res, status, { error: errorMessage(err) });
        if (status === 500) this.log.error(errorMessage(err));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolve);
    });
    this.log.info(`demo server on http://127.0.0.1:${port}`);
  }

  close(): void {
    this.server?.closeAllConnections();
    this.server?.close();
  }

  private recordRun(r: {
    scenario: string;
    eventId: number;
    ok: boolean;
    status: string;
    txCount: number;
    gasTotal: string;
    wrongSettlements: number;
    rounds: unknown[];
  }) {
    const dir = path.join(repoRoot(), "experiments", "results", "raw");
    const file = path.join(dir, "lab-runs.json");
    fs.mkdirSync(dir, { recursive: true });
    const list = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, "utf8")) as unknown[])
      : [];
    list.unshift({
      at: new Date().toISOString(),
      scenario: r.scenario,
      eventId: r.eventId,
      ok: r.ok,
      status: r.status,
      txCount: r.txCount,
      gasTotal: r.gasTotal,
      wrong: r.wrongSettlements,
      rounds: r.rounds.length,
    });
    fs.writeFileSync(file, JSON.stringify(list.slice(0, 50), null, 2));
  }

  private sourceUrl(idOrKey: string): string {
    const def = SOURCES.find((s) => s.key === idOrKey || String(s.id) === idOrKey);
    if (!def) throw new HttpError(404, `unknown source ${idOrKey}`);
    return this.urls.source(def.id);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (handlePreflight(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    let m: RegExpMatchArray | null;

    if (route === "GET /health") return sendJson(res, 200, { ok: true });

    if (route === "GET /accounts") {
      const entry = (index: number, role: string) => ({
        index,
        role,
        address: hardhatAccount(index).address,
      });
      return sendJson(res, 200, [
        entry(ACCOUNTS.admin, "admin / deployer"),
        ...ACCOUNTS.lps.map((i) => entry(i, "liquidity provider")),
        ...ACCOUNTS.holders.map((i) => entry(i, "policyholder")),
        entry(ACCOUNTS.keeper, "keeper"),
        ...ACCOUNTS.oracles.map((i) => entry(i, "oracle node")),
        entry(ACCOUNTS.challenger, "challenger"),
        entry(ACCOUNTS.spare, "spare"),
      ]);
    }

    if (route === "GET /state") {
      const d = this.deployments.current();
      return sendJson(res, 200, {
        deployment: d,
        chainTime: await chainNow(this.provider),
        block: await this.provider.getBlockNumber(),
        running: this.running,
      });
    }

    if (route === "POST /reset") {
      this.log.info("reset: redeploying and seeding");
      const d = await deployAndSeed(this.provider);
      return sendJson(res, 200, { ok: true, engine: d.addresses.engine });
    }

    if (route === "POST /seed") {
      const d = this.deployments.current();
      if (!d) throw new HttpError(409, "nothing deployed; POST /reset first");
      await seedEvents(this.provider, d);
      return sendJson(res, 200, { ok: true });
    }

    if (route === "POST /time/advance") {
      const body = (await readBody(req)) as { seconds?: number } | undefined;
      const seconds = Number(body?.seconds);
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new HttpError(400, "seconds must be > 0");
      await this.provider.send("evm_increaseTime", [Math.floor(seconds)]);
      await this.provider.send("evm_mine", []);
      return sendJson(res, 200, { chainTime: await chainNow(this.provider) });
    }

    if (route === "POST /mine") {
      const body = (await readBody(req)) as { blocks?: number } | undefined;
      const blocks = Math.min(Math.max(Number(body?.blocks ?? 1), 1), 100);
      for (let i = 0; i < blocks; i++) await this.provider.send("evm_mine", []);
      return sendJson(res, 200, { block: await this.provider.getBlockNumber() });
    }

    if ((m = url.pathname.match(/^\/sources\/([^/]+)\/mode$/)) && req.method === "POST") {
      const body = await readBody(req);
      return sendJson(res, 200, await postJson(`${this.sourceUrl(m[1])}/control`, body));
    }

    if (
      (m = url.pathname.match(/^\/nodes\/([^/]+)\/(mode|start|stop)$/)) &&
      req.method === "POST"
    ) {
      const body = m[2] === "mode" ? await readBody(req) : undefined;
      return sendJson(res, 200, await postJson(`${this.urls.oracle}/nodes/${m[1]}/${m[2]}`, body));
    }

    if (route === "GET /scenarios") {
      return sendJson(
        res,
        200,
        SCENARIOS.map(({ name, title, description, category, expect }) => ({
          name,
          title,
          description,
          category,
          expect,
        })),
      );
    }

    if ((m = url.pathname.match(/^\/scenarios\/([^/]+)\/run$/)) && req.method === "POST") {
      if (this.running) throw new HttpError(409, `scenario "${this.running}" is already running`);
      this.running = m[1];
      sseHeaders(res);
      try {
        const result = await this.runner.run(m[1], (e) => sseSend(res, e.type, e));
        this.recordRun(result);
        sseSend(res, "done", { scenario: m[1] });
      } catch (err) {
        sseSend(res, "failed", { message: errorMessage(err) });
      } finally {
        this.running = null;
        res.end();
      }
      return;
    }

    if (route === "POST /fund") {
      const body = (await readBody(req)) as { address?: string } | undefined;
      if (body?.address) {
        // Any wallet, e.g. the presenter's own MetaMask account: 100 test ETH on this chain only.
        if (!isAddress(body.address)) throw new HttpError(400, "not an address");
        await this.provider.send("hardhat_setBalance", [
          getAddress(body.address),
          "0x56bc75e2d63100000",
        ]);
        return sendJson(res, 200, { ok: true, address: getAddress(body.address), eth: 100 });
      }
      for (let i = 0; i < 20; i++) {
        await this.provider.send("hardhat_setBalance", [
          hardhatAccount(i).address,
          "0x21e19e0c9bab2400000",
        ]);
      }
      return sendJson(res, 200, { ok: true, eth: 10000 });
    }

    if (route === "GET /sources") {
      const out = [];
      for (const s of SOURCES) {
        try {
          out.push({
            id: s.id,
            key: s.key,
            name: s.name,
            ...(await getJson<Record<string, unknown>>(`${this.urls.source(s.id)}/control`)),
          });
        } catch {
          out.push({ id: s.id, key: s.key, name: s.name, unreachable: true });
        }
      }
      return sendJson(res, 200, out);
    }

    if (route === "GET /nodes") {
      return sendJson(res, 200, await getJson(`${this.urls.oracle}/status`));
    }

    if (route === "GET /keeper") {
      if (!this.urls.keeper) throw new HttpError(404, "no keeper configured");
      return sendJson(res, 200, await getJson(`${this.urls.keeper}/status`));
    }

    if (route === "POST /keeper/pause" || route === "POST /keeper/resume") {
      if (!this.urls.keeper) throw new HttpError(404, "no keeper configured");
      const action = route.endsWith("pause") ? "pause" : "resume";
      return sendJson(res, 200, await postJson(`${this.urls.keeper}/${action}`));
    }

    if (route === "GET /runs") {
      const file = path.join(repoRoot(), "experiments", "results", "raw", "lab-runs.json");
      return sendJson(
        res,
        200,
        fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [],
      );
    }

    if (route === "POST /experiments/run") {
      if (this.running) throw new HttpError(409, `"${this.running}" is already running`);
      this.running = "experiments";
      sseHeaders(res);
      const child = spawn(
        process.execPath,
        [
          path.join(repoRoot(), "node_modules", "hardhat", "internal", "cli", "bootstrap.js"),
          "run",
          "experiments/run.ts",
        ],
        {
          cwd: repoRoot(),
          env: { ...process.env },
        },
      );
      const forward = (chunk: Buffer) =>
        chunk
          .toString()
          .split(/\r?\n/)
          .filter(Boolean)
          .forEach((line) => sseSend(res, "progress", { line }));
      child.stdout.on("data", forward);
      child.stderr.on("data", forward);
      await new Promise<void>((resolve) =>
        child.on("close", (code) => {
          sseSend(res, code === 0 ? "done" : "failed", { code });
          resolve();
        }),
      );
      this.running = null;
      res.end();
      return;
    }

    if (route === "GET /experiments/latest") {
      const candidates = [
        path.join(repoRoot(), "frontend", "public", "experiments", "latest.json"),
        path.join(repoRoot(), "experiments", "results", "summary.json"),
      ];
      for (const file of candidates) {
        if (fs.existsSync(file))
          return sendJson(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
      }
      throw new HttpError(
        404,
        "no experiment results yet (the experiment runner is added in a later milestone)",
      );
    }

    sendJson(res, 404, { error: "not found" });
  }
}

export async function startDemoServer(
  opts: { rpcUrl?: string; port?: number; urls?: RunnerUrls } = {},
): Promise<DemoServer> {
  const log = makeLogger("demo-server");
  const provider = makeProvider(opts.rpcUrl ?? defaultRpcUrl(), defaultChainId());
  const server = new DemoServer(provider, new DeploymentWatcher(defaultChainId()), log, opts.urls);
  await server.listen(opts.port);
  return server;
}
