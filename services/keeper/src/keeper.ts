import http from "node:http";
import { Contract, JsonRpcProvider } from "ethers";
import {
  ACCOUNTS,
  DeploymentWatcher,
  Logger,
  TiesContracts,
  chainNow,
  connectContracts,
  defaultChainId,
  defaultRpcUrl,
  describeError,
  errorMessage,
  handlePreflight,
  hardhatSigner,
  HttpError,
  PORTS,
  sendJson,
  type SerialWallet,
  makeLogger,
  makeProvider,
} from "../../shared/src";

const Status = { NONE: 0, COMMIT: 1, REVEAL: 2, DEFAULT_PENDING: 3, DISPUTED: 4, FINAL: 5 };

/** Learning needs this much gas left when an event becomes final (engine constant, 6M). */
const GAS_MARGIN_PERCENT = 115n;

export interface KeeperAction {
  eventId: number;
  action: "openRound" | "finalizeRound" | "applyDefault";
  hash?: string;
  error?: string;
}

/**
 * Untrusted orchestrator: opens rounds when observation ends, finalizes rounds after the reveal
 * deadline and applies defaults after the challenge period. The contract re-verifies everything,
 * so a wrong or missing call here can only delay settlement, never change its result.
 */
export class Keeper {
  private contracts?: TiesContracts;
  private signer: SerialWallet;
  private seenVersion = -1;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private server?: http.Server;
  /** While paused the keeper sends nothing; rounds wait for a manual call (presenter demos). */
  paused = false;
  /** Calls that reverted recently, to avoid hammering the node every tick. */
  private readonly cooldown = new Map<string, number>();
  readonly actions: KeeperAction[] = [];

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly deployments: DeploymentWatcher,
    private readonly log: Logger,
  ) {
    this.signer = hardhatSigner(ACCOUNTS.keeper, provider);
  }

  start(pollMs = 500): void {
    this.timer = setInterval(() => void this.tick(), pollMs);
    this.log.info("keeper running");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.server?.close();
  }

  /** Pause or resume automatic calls. */
  setPaused(paused: boolean): void {
    if (this.paused !== paused) this.log.info(paused ? "paused" : "resumed");
    this.paused = paused;
  }

  status(): { paused: boolean; actions: KeeperAction[] } {
    return { paused: this.paused, actions: this.actions.slice(-20) };
  }

  /** Control endpoint: GET /status, POST /pause, POST /resume (127.0.0.1 only). */
  listen(port = PORTS.keeper): Promise<void> {
    this.server = http.createServer((req, res) => {
      try {
        if (handlePreflight(req, res)) return;
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (path === "/status" || path === "/health") return sendJson(res, 200, this.status());
        if (req.method === "POST" && (path === "/pause" || path === "/resume")) {
          this.setPaused(path === "/pause");
          return sendJson(res, 200, this.status());
        }
        throw new HttpError(404, "not found");
      } catch (err) {
        sendJson(res, err instanceof HttpError ? err.status : 500, { error: errorMessage(err) });
      }
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.log.info(`control on http://127.0.0.1:${port}/status`);
        resolve();
      });
    });
  }

  async tick(): Promise<void> {
    if (this.ticking || this.paused) return;
    this.ticking = true;
    try {
      const d = this.deployments.current();
      if (!d) return;
      if (this.deployments.version !== this.seenVersion) {
        this.seenVersion = this.deployments.version;
        this.contracts = connectContracts(d, this.provider);
        this.cooldown.clear();
        this.log.info(`watching engine ${d.addresses.engine}`);
      }
      const { book, engine } = this.contracts!;
      const count = Number(await book.eventCount());
      const now = await chainNow(this.provider);
      for (let eventId = 1; eventId <= count; eventId++) {
        const st = await engine.eventState(eventId);
        const status = Number(st.status);
        if (status === Status.FINAL || status === Status.DISPUTED) continue;
        if (status === Status.NONE) {
          const meta = await book.eventMeta(eventId);
          if (now >= Number(meta.observationEnd)) await this.call("openRound", eventId);
        } else if (status === Status.COMMIT || status === Status.REVEAL) {
          if (now >= Number(st.revealDeadline)) await this.call("finalizeRound", eventId);
        } else if (status === Status.DEFAULT_PENDING) {
          if (now >= Number(st.challengeDeadline)) await this.call("applyDefault", eventId);
        }
      }
    } catch (err) {
      this.log.warn(`tick failed: ${errorMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  warn(message: string): void {
    this.log.warn(message);
  }

  private async call(action: KeeperAction["action"], eventId: number): Promise<void> {
    const key = `${action}:${eventId}`;
    const wait = this.cooldown.get(key);
    if (wait && Date.now() < wait) return;
    const { engine } = this.contracts!;
    const writer = engine.connect(this.signer) as Contract;
    try {
      // Finalizing needs a lot of gas left for the learning update; estimateGas finds the
      // smallest limit at which the call succeeds, and a margin keeps it safe.
      const gas = (await writer[action].estimateGas(eventId)) as bigint;
      const tx = await writer[action](eventId, { gasLimit: (gas * GAS_MARGIN_PERCENT) / 100n });
      await tx.wait();
      this.log.info(`${action}(${eventId}) -> ${tx.hash}`);
      this.actions.push({ eventId, action, hash: tx.hash });
    } catch (err) {
      const reason = describeError(
        [engine.interface, this.contracts!.book.interface, this.contracts!.vault.interface],
        err,
      );
      this.cooldown.set(key, Date.now() + 3000);
      this.log.warn(`${action}(${eventId}) failed: ${reason}`);
      this.actions.push({ eventId, action, error: reason });
    }
  }
}

export function startKeeper(
  opts: { rpcUrl?: string; chainId?: number; pollMs?: number; port?: number | null } = {},
): Keeper {
  const chainId = opts.chainId ?? defaultChainId();
  const provider = makeProvider(opts.rpcUrl ?? defaultRpcUrl(), chainId);
  const keeper = new Keeper(provider, new DeploymentWatcher(chainId), makeLogger("keeper"));
  keeper.start(opts.pollMs);
  if (opts.port !== null) {
    keeper.listen(opts.port).catch((err) => keeper.warn(`control endpoint: ${errorMessage(err)}`));
  }
  return keeper;
}
