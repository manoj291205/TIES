import { JsonRpcProvider } from "ethers";
import { Deployment } from "../../services/shared/src";
import { exportAbis } from "./abi";
import { deployAll } from "./deploy";
import { SeedOptions, seedAll } from "./seed";

/** Deploys the contracts, exports the ABIs and seeds the demo state. */
export async function deployAndSeed(
  provider: JsonRpcProvider,
  opts: SeedOptions = {},
): Promise<Deployment> {
  const deployment = await deployAll(provider);
  exportAbis();
  await seedAll(provider, deployment, opts);
  return deployment;
}
