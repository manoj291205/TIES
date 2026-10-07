// Runs solhint on contracts/, but passes cleanly while no .sol files exist yet.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function hasSol(dir) {
  return readdirSync(dir).some((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? hasSol(p) : name.endsWith(".sol");
  });
}

if (!hasSol("contracts")) {
  console.log("solhint: no Solidity files yet, skipping");
  process.exit(0);
}
const r = spawnSync("npx", ["solhint", "contracts/**/*.sol"], { stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
