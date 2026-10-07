import { Wallet } from "ethers";
import {
  DeploymentWatcher,
  SOURCES,
  defaultRpcUrl,
  ensureSourceKeys,
  makeLogger,
  makeProvider,
} from "../../shared/src";
import { SourceServer } from "./server";
import { TruthStore } from "./truth";

export { SourceServer, TruthStore };

export interface RunningSources {
  servers: SourceServer[];
  truth: TruthStore;
  close(): Promise<void>;
}

/** Starts all nine source servers (ports 7101-7109) in this process. */
export async function startSources(
  opts: { rpcUrl?: string; chainId?: number; portOffset?: number } = {},
): Promise<RunningSources> {
  const log = makeLogger("sources");
  const provider = makeProvider(opts.rpcUrl ?? defaultRpcUrl(), opts.chainId);
  const deployments = new DeploymentWatcher(opts.chainId ?? 31337);
  const keys = ensureSourceKeys();
  const truth = new TruthStore();
  const servers: SourceServer[] = [];
  for (const def of SOURCES) {
    const server = new SourceServer({
      def: { ...def, port: def.port + (opts.portOffset ?? 0) },
      wallet: new Wallet(keys[def.key]),
      truth,
      deployments,
      provider,
      log: makeLogger(def.key),
    });
    await server.listen();
    servers.push(server);
  }
  log.info("all sources are up");
  return {
    servers,
    truth,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
      provider.destroy();
    },
  };
}
