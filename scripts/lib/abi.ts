import fs from "node:fs";
import path from "node:path";
import { ContractName, abiDir, artifactsDir } from "../../services/shared/src";

const NAMES: ContractName[] = [
  "Vault",
  "TIESRegistry",
  "PolicyBook",
  "SignedAdapterVerifier",
  "EscalationPlanner",
  "LearningModule",
  "SettlementEngine",
];

function find(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = find(full, name);
      if (hit) return hit;
    } else if (entry.name === `${name}.json`) return full;
  }
  return null;
}

/** Writes each contract's ABI to frontend/src/contracts/abi/<Name>.json. */
export function exportAbis(): string[] {
  fs.mkdirSync(abiDir(), { recursive: true });
  const written: string[] = [];
  for (const name of NAMES) {
    const artifact = find(artifactsDir(), name);
    if (!artifact) throw new Error(`artifact for ${name} not found; run "npx hardhat compile"`);
    const { abi } = JSON.parse(fs.readFileSync(artifact, "utf8")) as { abi: unknown };
    const out = path.join(abiDir(), `${name}.json`);
    fs.writeFileSync(out, JSON.stringify(abi, null, 2) + "\n");
    written.push(out);
  }
  return written;
}
