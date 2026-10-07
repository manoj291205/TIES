import { defaultRpcUrl, makeLogger, makeProvider, waitForRpc } from "../services/shared/src";
import { deployAndSeed } from "./lib/stack";

/** One step for the local stack: deploy, export ABIs, seed. Runs once the node answers. */
async function main() {
  const provider = makeProvider(defaultRpcUrl());
  await waitForRpc(provider);
  const d = await deployAndSeed(provider);
  makeLogger("stack").info(`deployed and seeded (engine ${d.addresses.engine})`);
  provider.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
