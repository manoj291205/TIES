import { defaultRpcUrl, makeLogger, makeProvider, waitForRpc } from "../services/shared/src";
import { deployAll } from "./lib/deploy";
import { exportAbis } from "./lib/abi";

/** Deploys the contracts to RPC_URL (default: local Hardhat node) and exports the ABIs. */
async function main() {
  const log = makeLogger("deploy");
  const provider = makeProvider(defaultRpcUrl());
  await waitForRpc(provider);
  const deployment = await deployAll(provider);
  exportAbis();
  log.info(`done: chain ${deployment.chainId}, engine ${deployment.addresses.engine}`);
  provider.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
