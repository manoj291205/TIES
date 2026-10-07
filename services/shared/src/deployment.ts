import { Contract, ContractRunner, InterfaceAbi } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { abiDir, artifactsDir, deploymentsDir } from "./paths";

export interface Deployment {
  chainId: number;
  deployBlock: number;
  deployedAt: string;
  addresses: {
    vault: string;
    registry: string;
    book: string;
    verifier: string;
    planner: string;
    learning: string;
    engine: string;
  };
  sources: {
    id: number;
    key: string;
    name: string;
    category: number;
    signer: string;
    port: number;
  }[];
}

export type ContractName =
  | "Vault"
  | "TIESRegistry"
  | "PolicyBook"
  | "SignedAdapterVerifier"
  | "EscalationPlanner"
  | "LearningModule"
  | "SettlementEngine";

const abiCache = new Map<string, InterfaceAbi>();

function findArtifact(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findArtifact(full, name);
      if (hit) return hit;
    } else if (entry.name === `${name}.json`) {
      return full;
    }
  }
  return null;
}

/** ABI of a contract, from the exported ABI folder or else the Hardhat artifacts. */
export function loadAbi(name: ContractName): InterfaceAbi {
  const cached = abiCache.get(name);
  if (cached) return cached;
  const exported = path.join(abiDir(), `${name}.json`);
  let abi: InterfaceAbi;
  if (fs.existsSync(exported)) {
    abi = JSON.parse(fs.readFileSync(exported, "utf8")) as InterfaceAbi;
  } else {
    const artifact = findArtifact(artifactsDir(), name);
    if (!artifact) throw new Error(`artifact for ${name} not found; run "npx hardhat compile"`);
    abi = (JSON.parse(fs.readFileSync(artifact, "utf8")) as { abi: InterfaceAbi }).abi;
  }
  abiCache.set(name, abi);
  return abi;
}

/** Bytecode and ABI from the Hardhat artifacts (used by the deploy script). */
export function loadArtifact(name: string): { abi: InterfaceAbi; bytecode: string } {
  const artifact = findArtifact(artifactsDir(), name);
  if (!artifact) throw new Error(`artifact for ${name} not found; run "npx hardhat compile"`);
  return JSON.parse(fs.readFileSync(artifact, "utf8")) as { abi: InterfaceAbi; bytecode: string };
}

export const deploymentFile = (chainId: number) => path.join(deploymentsDir(), `${chainId}.json`);

/** Reads the deployment file again whenever it changes (a reset redeploys the contracts). */
export class DeploymentWatcher {
  private mtime = 0;
  private value: Deployment | null = null;
  private generation = 0;

  constructor(private readonly chainId = 31337) {}

  /** Bumped every time a different deployment is loaded. */
  get version(): number {
    return this.generation;
  }

  current(): Deployment | null {
    const file = deploymentFile(this.chainId);
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs !== this.mtime) {
        this.value = JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
        this.mtime = stat.mtimeMs;
        this.generation += 1;
      }
    } catch {
      // not deployed yet (or being rewritten); keep the last good value
    }
    return this.value;
  }
}

export interface TiesContracts {
  vault: Contract;
  registry: Contract;
  book: Contract;
  engine: Contract;
  verifier: Contract;
  planner: Contract;
  learning: Contract;
}

export function connectContracts(d: Deployment, runner: ContractRunner): TiesContracts {
  const make = (address: string, name: ContractName) =>
    new Contract(address, loadAbi(name), runner);
  return {
    vault: make(d.addresses.vault, "Vault"),
    registry: make(d.addresses.registry, "TIESRegistry"),
    book: make(d.addresses.book, "PolicyBook"),
    engine: make(d.addresses.engine, "SettlementEngine"),
    verifier: make(d.addresses.verifier, "SignedAdapterVerifier"),
    planner: make(d.addresses.planner, "EscalationPlanner"),
    learning: make(d.addresses.learning, "LearningModule"),
  };
}
