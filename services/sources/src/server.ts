import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JsonRpcProvider, Wallet } from "ethers";
import http from "node:http";
import { z } from "zod";
import {
  DeploymentWatcher,
  HttpError,
  Logger,
  SourceDef,
  errorMessage,
  handlePreflight,
  hashJson,
  observationKeyFromArgs,
  readBody,
  reportDigest,
  sendJson,
  signReportDigest,
  sleep,
  toolHashOf,
} from "../../shared/src";
import { rainfallMm } from "./openMeteo";
import { TruthStore, gaussian } from "./truth";

export interface SourceControl {
  mode: "honest" | "offset";
  offset: number;
  sigma: number;
  delayMs: number;
  down: boolean;
  seed: string;
}

export interface SourceContext {
  def: SourceDef;
  wallet: Wallet;
  truth: TruthStore;
  deployments: DeploymentWatcher;
  provider: JsonRpcProvider;
  log: Logger;
}

const MAX_UNITS = { get_flight_delay: 720, get_rainfall_24h: 300 } as const;

export class SourceServer {
  readonly control: SourceControl;
  private server?: http.Server;

  constructor(private readonly ctx: SourceContext) {
    this.control = {
      mode: "honest",
      offset: 0,
      sigma: ctx.def.sigma,
      delayMs: 0,
      down: false,
      seed: "ties",
    };
  }

  /** The signed report for one tool call (what the MCP tool returns). */
  async report(args: Record<string, unknown>) {
    const { def, wallet, truth, deployments, provider, log } = this.ctx;
    const c = this.control;
    if (c.down) throw new Error(`${def.key} is unavailable`);
    if (c.delayMs > 0) await sleep(c.delayMs);
    const deployment = deployments.current();
    if (!deployment) throw new Error("contracts are not deployed yet");

    const eventKey = observationKeyFromArgs(def.tool, args);
    let base: number;
    if (def.kind === "real") {
      base = await rainfallMm(Number(args.lat), Number(args.lon), String(args.date), log);
    } else {
      let known = truth.get(eventKey);
      if (known === undefined && def.tool === "get_rainfall_24h") {
        // The local station replays the archive when nobody set a ground truth for the day.
        known = await rainfallMm(Number(args.lat), Number(args.lon), String(args.date), log);
        truth.set(eventKey, known);
      }
      if (known === undefined) throw new Error(`no ground truth for "${eventKey}"`);
      base = known;
    }
    const noise = c.sigma > 0 ? gaussian(c.seed, def.key, eventKey) * c.sigma : 0;
    const units = Math.min(
      Math.max(base + (c.mode === "offset" ? c.offset : 0) + noise, 0),
      MAX_UNITS[def.tool],
    );
    const value = BigInt(Math.round(units * 1000));
    const ts = (await provider.getBlock("latest"))!.timestamp;

    const toolHash = toolHashOf(def.tool);
    const argsHash = hashJson(args);
    const responseHash = hashJson({
      source: def.key,
      tool: def.tool,
      eventKey,
      value: value.toString(),
      ts,
    });
    const eventId = Number(args.eventId);
    const digest = reportDigest({
      chainId: deployment.chainId,
      engine: deployment.addresses.engine,
      eventId,
      value,
      ts,
      toolHash,
      argsHash,
      responseHash,
    });
    const signature = await signReportDigest(wallet, digest);
    return { value: value.toString(), ts, toolHash, argsHash, responseHash, signature };
  }

  private mcpServer(): McpServer {
    const { def, log } = this.ctx;
    const server = new McpServer({ name: `ties-${def.key.toLowerCase()}`, version: "0.1.0" });
    const run = async (args: Record<string, unknown>) => {
      try {
        const out = await this.report(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        log.warn(`tool ${def.tool} failed: ${errorMessage(err)}`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: errorMessage(err) }],
        };
      }
    };
    if (def.tool === "get_flight_delay") {
      server.registerTool(
        "get_flight_delay",
        {
          description: "Signed flight delay (minutes) for a flight on a date.",
          inputSchema: { eventId: z.number().int(), flight: z.string(), date: z.string() },
        },
        (args) => run(args),
      );
    } else {
      server.registerTool(
        "get_rainfall_24h",
        {
          description: "Signed 24-hour rainfall (mm) at a location on a date.",
          inputSchema: {
            eventId: z.number().int(),
            lat: z.number(),
            lon: z.number(),
            date: z.string(),
          },
        },
        (args) => run(args),
      );
    }
    return server;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (handlePreflight(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const { def, truth } = this.ctx;

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "this MCP endpoint is stateless; use POST" });
        return;
      }
      const body = await readBody(req);
      const server = this.mcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (url.pathname === "/report" && req.method === "POST") {
      // Plain-HTTP twin of the MCP tool, so the operator console in a browser can fetch a signed
      // report by hand. Oracle nodes still use MCP only.
      const body = (await readBody(req)) as Record<string, unknown> | undefined;
      sendJson(res, 200, await this.report(body ?? {}));
      return;
    }
    if (url.pathname === "/health") {
      sendJson(res, 200, { source: def.key, name: def.name, down: this.control.down });
      return;
    }
    if (url.pathname === "/control") {
      if (req.method === "POST") {
        const body = (await readBody(req)) as Partial<SourceControl> | undefined;
        this.update(body ?? {});
      }
      sendJson(res, 200, { source: def.key, ...this.control });
      return;
    }
    if (url.pathname === "/truth") {
      if (req.method === "PUT" || req.method === "POST") {
        const body = (await readBody(req)) as Record<string, number> | undefined;
        for (const [k, v] of Object.entries(body ?? {})) {
          if (typeof v !== "number") throw new HttpError(400, `truth for "${k}" must be a number`);
          truth.set(k, v);
        }
      }
      sendJson(res, 200, truth.all());
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  update(patch: Partial<SourceControl>): void {
    const c = this.control;
    if (patch.mode !== undefined) {
      if (patch.mode !== "honest" && patch.mode !== "offset") {
        throw new HttpError(400, 'mode must be "honest" or "offset"');
      }
      c.mode = patch.mode;
    }
    if (patch.offset !== undefined) c.offset = Number(patch.offset);
    if (patch.sigma !== undefined) c.sigma = Number(patch.sigma);
    if (patch.delayMs !== undefined) c.delayMs = Number(patch.delayMs);
    if (patch.down !== undefined) c.down = Boolean(patch.down);
    if (patch.seed !== undefined) c.seed = String(patch.seed);
  }

  listen(): Promise<void> {
    const { def, log } = this.ctx;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (!res.headersSent) sendJson(res, status, { error: errorMessage(err) });
        else res.end();
        if (status === 500) log.error(`request failed: ${errorMessage(err)}`);
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(def.port, "127.0.0.1", () => {
        log.info(
          `${def.key} "${def.name}" (${def.kind}) listening on http://127.0.0.1:${def.port}`,
        );
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}
