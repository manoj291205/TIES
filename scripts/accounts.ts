/**
 * Prints the local demo accounts with their roles, addresses and private keys, for importing
 * into MetaMask. These are Hardhat's public development keys: anyone can read them, so they are
 * only for the local chain (31337). Never send real funds to them.
 *
 *   npm run accounts
 */
import { ACCOUNTS, SOURCES, hardhatAccount } from "../services/shared/src";
import { loadNodeConfig } from "./lib/seed";

const roles: Record<number, string> = { [ACCOUNTS.admin]: "Admin (deployer, registry, disputes)" };
ACCOUNTS.lps.forEach((i, n) => (roles[i] = `Liquidity provider ${n + 1}`));
ACCOUNTS.holders.forEach((i, n) => (roles[i] = `Policyholder ${n + 1}`));
roles[ACCOUNTS.keeper] = "Keeper (used by the keeper service)";
roles[ACCOUNTS.challenger] = "Challenger";
roles[ACCOUNTS.spare] = "Spare";
for (const n of loadNodeConfig()) {
  const source = SOURCES.find((s) => s.id === n.sourceId);
  const label = `Oracle ${n.id} -> S${n.sourceId} ${source?.name ?? ""}`.trim();
  roles[n.account] = roles[n.account] ? `${roles[n.account]}; ${n.id} -> S${n.sourceId}` : label;
}

const pick = process.argv.includes("--all")
  ? Array.from({ length: 20 }, (_, i) => i)
  : [
      ACCOUNTS.admin,
      ACCOUNTS.lps[0],
      ACCOUNTS.holders[0],
      ACCOUNTS.holders[1],
      10,
      ACCOUNTS.challenger,
    ];

console.log("Local demo accounts (Hardhat Localhost, chain 31337, currency ETH, 10,000 ETH each)");
console.log("PUBLIC TEST KEYS: use them on the local chain only.\n");
for (const i of pick) {
  const w = hardhatAccount(i);
  console.log(`#${String(i).padEnd(2)} ${roles[i] ?? ""}`);
  console.log(`    address     ${w.address}`);
  console.log(`    private key ${w.privateKey}\n`);
}
console.log(
  "MetaMask: account menu > Add account or hardware wallet > Import account > paste the key.",
);
if (!process.argv.includes("--all")) console.log("Run with -- --all for all 20 accounts.");
