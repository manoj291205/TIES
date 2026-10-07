import {
  DeploymentWatcher,
  defaultChainId,
  defaultRpcUrl,
  makeLogger,
  makeProvider,
  waitForRpc,
} from "../services/shared/src";
import { seedAll } from "./lib/seed";

/** Seeds the deployment found in frontend/src/contracts/deployments/<chainId>.json. */
async function main() {
  const log = makeLogger("seed");
  const provider = makeProvider(defaultRpcUrl());
  await waitForRpc(provider);
  const deployment = new DeploymentWatcher(defaultChainId()).current();
  if (!deployment) throw new Error("no deployment file; run the deploy script first");
  await seedAll(provider, deployment);
  log.info("seeded");
  provider.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
