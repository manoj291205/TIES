import fs from "node:fs";
import path from "node:path";

let cached: string | undefined;

/** Repository root: the closest ancestor holding hardhat.config.ts. */
export function repoRoot(): string {
  if (cached) return cached;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "hardhat.config.ts"))) {
      cached = dir;
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("repository root not found");
}

/** Where deployment files live; tests point TIES_DEPLOYMENTS_DIR somewhere else. */
export const deploymentsDir = () =>
  process.env.TIES_DEPLOYMENTS_DIR ??
  path.join(repoRoot(), "frontend", "src", "contracts", "deployments");
export const abiDir = () => path.join(repoRoot(), "frontend", "src", "contracts", "abi");
export const artifactsDir = () => path.join(repoRoot(), "artifacts", "contracts");
