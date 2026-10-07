import { Contract, ContractFactory, JsonRpcProvider, Signer, Wallet } from "ethers";
import fs from "node:fs";
import path from "node:path";
import {
  FLIGHT_DELAY,
  FLIGHT_DELAY_PARAMS,
  RAIN_24H,
  RAIN_24H_PARAMS,
} from "../../packages/ties-math/src";
import {
  Deployment,
  SOURCES,
  deploymentFile,
  ensureSourceKeys,
  loadArtifact,
  makeLogger,
  ACCOUNTS,
  hardhatSigner,
} from "../../services/shared/src";

const log = makeLogger("deploy");

async function deploy(signer: Signer, name: string, args: unknown[]): Promise<string> {
  const { abi, bytecode } = loadArtifact(name);
  const contract = await new ContractFactory(abi, bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  log.info(`${name} deployed at ${address}`);
  return address;
}

export interface DeployOptions {
  /** Signer that becomes admin; defaults to Hardhat account #0. */
  admin?: Signer;
}

/**
 * Deploys the whole system, wires the roles and configures both categories (spec 3.2 defaults).
 * Does not register sources or oracles; see `seedAll`.
 */
export async function deployAll(
  provider: JsonRpcProvider,
  opts: DeployOptions = {},
): Promise<Deployment> {
  const admin = opts.admin ?? hardhatSigner(ACCOUNTS.admin, provider);
  const adminAddress = await admin.getAddress();
  const chainId = Number((await provider.getNetwork()).chainId);

  const vault = await deploy(admin, "Vault", [adminAddress]);
  const registry = await deploy(admin, "TIESRegistry", [adminAddress]);
  const book = await deploy(admin, "PolicyBook", [vault, registry, adminAddress]);
  const verifier = await deploy(admin, "SignedAdapterVerifier", [registry]);
  const planner = await deploy(admin, "EscalationPlanner", [registry, book]);
  const learning = await deploy(admin, "LearningModule", [registry, book, adminAddress]);
  const engine = await deploy(admin, "SettlementEngine", [
    vault,
    book,
    registry,
    verifier,
    planner,
    learning,
    adminAddress,
  ]);

  const abi = (name: string) => loadArtifact(name).abi;
  const vaultC = new Contract(vault, abi("Vault"), admin);
  const registryC = new Contract(registry, abi("TIESRegistry"), admin);
  const learningC = new Contract(learning, abi("LearningModule"), admin);
  const bookC = new Contract(book, abi("PolicyBook"), admin);
  const send = async (tx: Promise<{ wait(): Promise<unknown> }>) => (await tx).wait();

  await send(vaultC.grantRole(await vaultC.BOOK_ROLE(), book));
  await send(vaultC.grantRole(await vaultC.ENGINE_ROLE(), engine));
  await send(registryC.grantRole(await registryC.ENGINE_ROLE(), learning));
  await send(learningC.setEngine(engine));
  await send(bookC.setEngine(engine));
  await send(registryC.setCategory(FLIGHT_DELAY, FLIGHT_DELAY_PARAMS));
  await send(registryC.setCategory(RAIN_24H, RAIN_24H_PARAMS));

  const keys = ensureSourceKeys();
  const deployment: Deployment = {
    chainId,
    deployBlock: await provider.getBlockNumber(),
    deployedAt: new Date().toISOString(),
    addresses: { vault, registry, book, verifier, planner, learning, engine },
    sources: SOURCES.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      category: s.category,
      signer: new Wallet(keys[s.key]).address,
      port: s.port,
    })),
  };
  const file = deploymentFile(chainId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));
  log.info(`wrote ${path.relative(process.cwd(), file)}`);
  return deployment;
}
