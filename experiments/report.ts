/**
 * Writes docs/EXPERIMENTS.md from experiments/results/summary.json, so every number in the
 * document is copied from the run and none is typed by hand.
 *   npm run experiments:report
 */
import fs from "node:fs";
import path from "node:path";

interface Scn {
  ties: Record<string, number>;
  baselines: Record<string, Record<string, number>>;
}
interface Gas {
  n: number;
  tiesFinalizeRound: number;
  tiesApplyDefault: number | null;
  baselines: Record<string, number | string>;
}
type Row = Record<string, number>;
const summary = JSON.parse(
  fs.readFileSync(path.join(__dirname, "results", "summary.json"), "utf8"),
) as {
  generatedAt: string;
  elapsedSeconds: number;
  config: {
    eventsPerScenario: number;
    policiesPerEvent: number;
    sweepEvents: number;
    seed: number;
    payoutEthPerPolicy: string;
    network: string;
    notes: string[];
  };
  scenarios: Record<string, Scn>;
  gasVsPolicies: Gas[];
  sweeps: { compromisedSources: Row[]; uMin: Row[]; alpha: Row[] };
};
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const int = (v: number) => Math.round(v).toLocaleString("en-US");
const NAMES: Record<string, string> = {
  single: "Single oracle",
  avg2: "2-report average",
  median3: "2-of-3 median",
  median7: "7-oracle median",
};
const B = ["single", "avg2", "median3", "median7"];
const table = (head: string[], rows: string[][]) =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

const c = summary.config;
const out: string[] = [];
out.push(`# Experiments

Generated from \`experiments/results/summary.json\` by \`npm run experiments:report\`. Do not edit by hand.

Run: ${new Date(summary.generatedAt).toISOString()}, ${c.eventsPerScenario} events x ${c.policiesPerEvent} policies per scenario, sweeps of ${c.sweepEvents} events, seed ${c.seed}, ${c.payoutEthPerPolicy} ETH payout per policy, ${c.network}. Elapsed ${summary.elapsedSeconds} s.

## Method

- Every number comes from real transactions and receipts on the in-process Hardhat network. TIES runs the full contracts (commit, reveal, aggregation, range settlement, escalation, default). Each baseline is its own contract with its own pool and a per-policy \`settleAll\` loop (\`contracts/baselines\`).
- For each event the ground truth is drawn from 60 to 300 minutes; ${c.policiesPerEvent} policies are placed at thresholds within 30 minutes either side of the truth (2 minutes for \`borderline\`), so many sit close to the truth.
- All systems are fed the same source readings: truth, plus the scenario's offset, plus deterministic Gaussian noise per source (sigma 2 to 4 minutes). Baselines ask the first 1, 2 or 3 oracle keys of the scenario's committee, or seven keys for the 7-oracle median.
- "Wrong" is a policy settled the opposite way from the ground truth (it pays iff the truth is at least its threshold), as a share of all policies. Policies that are not settled (an event waiting for the admin, or a baseline that never reached its quorum) are counted as held, not wrong.
- For TIES, "settled by evidence" means decided by the running interval before any default; "by default" means decided by the default rule after the challenge period; "held" means still undecided (disputed, waiting for the admin).
- Oracle transactions count commits and reveals separately for TIES (a reveal that reverts still counts); a baseline report is one transaction.
- Each scenario uses a fresh deployment, so reputations and learned dependence carry from one event to the next within a scenario.

Notes recorded by the runner:

${c.notes.map((n: string) => `- ${n}`).join("\n")}

## Scenarios
`);

const rows: string[][] = [];
for (const [name, r] of Object.entries(summary.scenarios)) {
  rows.push([`\`${name}\``, pct(r.ties.wrongRate), ...B.map((b) => pct(r.baselines[b].wrongRate))]);
}
out.push("### Wrong settlements (share of all policies)\n");
out.push(table(["Scenario", "TIES", ...B.map((b) => NAMES[b])], rows));

const rows2: string[][] = [];
for (const [name, r] of Object.entries(summary.scenarios)) {
  rows2.push([
    `\`${name}\``,
    pct(r.ties.autoRate),
    pct(r.ties.defaultRate),
    pct(r.ties.heldRate),
    pct(r.ties.wrongAmongAuto ?? 0),
    pct(r.ties.wrongAmongDefault ?? 0),
    r.ties.roundsPerEvent.toFixed(2),
    pct(r.ties.firstRoundInsufficientRate),
  ]);
}
out.push("\n### TIES: how policies were decided\n");
out.push(
  table(
    [
      "Scenario",
      "By evidence",
      "By default",
      "Held",
      "Wrong among evidence-settled",
      "Wrong among defaulted",
      "Rounds per event",
      "Round 1 insufficient",
    ],
    rows2,
  ),
);

const rowsSettled: string[][] = [];
for (const [name, r] of Object.entries(summary.scenarios)) {
  rowsSettled.push([
    `\`${name}\``,
    pct(r.ties.autoRate + r.ties.defaultRate),
    ...B.map((b) => pct(r.baselines[b].settledRate)),
  ]);
}
out.push("\n### Share of policies that were settled at all\n");
out.push(
  "A baseline that never reaches its quorum leaves its policies unsettled, which the wrong-settlement table counts as not wrong. Read the two tables together.\n",
);
out.push(table(["Scenario", "TIES", ...B.map((b) => NAMES[b])], rowsSettled));

const rows3: string[][] = [];
for (const [name, r] of Object.entries(summary.scenarios)) {
  rows3.push([
    `\`${name}\``,
    r.ties.oracleTxsPerEvent.toFixed(2),
    ...B.map((b) => r.baselines[b].oracleTxsPerEvent.toFixed(2)),
  ]);
}
out.push("\n### Oracle transactions per event\n");
out.push(table(["Scenario", "TIES", ...B.map((b) => NAMES[b])], rows3));

const rows4: string[][] = [];
for (const [name, r] of Object.entries(summary.scenarios)) {
  rows4.push([
    `\`${name}\``,
    int(r.ties.oracleGasPerEvent),
    int(r.ties.settleGasPerEvent),
    int(r.ties.gasPerPolicy),
    ...B.map((b) => int(r.baselines[b].settleGasPerEvent)),
  ]);
}
out.push("\n### Gas per event\n");
out.push(
  table(
    [
      "Scenario",
      "TIES oracle gas",
      "TIES settle gas (all rounds and default)",
      "TIES settle gas per policy",
      ...B.map((b) => `${NAMES[b]} settleAll`),
    ],
    rows4,
  ),
);

out.push("\n## Settling gas against the number of policies\n");
out.push(
  table(
    ["Policies", "TIES finalizeRound", "TIES applyDefault", ...B.map((b) => NAMES[b])],
    summary.gasVsPolicies.map((g: Gas) => [
      String(g.n),
      int(g.tiesFinalizeRound),
      g.tiesApplyDefault == null ? "-" : int(g.tiesApplyDefault),
      ...B.map((b) =>
        typeof g.baselines[b] === "number" ? int(g.baselines[b]) : String(g.baselines[b]),
      ),
    ]),
  ),
);
const last = summary.gasVsPolicies[summary.gasVsPolicies.length - 1];
const perPolicy = typeof last.baselines.single === "number" ? last.baselines.single / last.n : null;
if (perPolicy) {
  out.push(
    `\nAt ${last.n} policies the single-oracle baseline costs ${int(Number(last.baselines.single))} gas, about ${int(perPolicy)} gas per policy. Extrapolated linearly (not measured), it would reach the 30,000,000 block gas limit at about ${int(30_000_000 / perPolicy)} policies. No baseline exceeded the limit in the measured range.\n`,
  );
}
out.push("![Gas against policies](figures/gas_vs_policies.png)\n");

out.push("## Sweeps\n");
out.push("### Compromised sources (each +90 minutes, among the first three oracle keys)\n");
out.push(
  table(
    ["Compromised", "TIES", ...B.map((b) => NAMES[b])],
    summary.sweeps.compromisedSources.map((s: Row) => [
      String(s.compromisedSources),
      pct(s.ties),
      ...B.map((b) => pct(s[b])),
    ]),
  ),
);
out.push("\n![Wrong settlements against compromised sources](figures/wrong_vs_compromised.png)\n");
out.push("### Escalation trigger u_min\n");
out.push(
  table(
    ["u_min (ETH)", "Oracle txs per event", "Rounds per event", "Wrong", "By evidence"],
    summary.sweeps.uMin.map((s: Row) => [
      String(s.uMinEth),
      s.oracleTxsPerEvent.toFixed(2),
      s.roundsPerEvent.toFixed(2),
      pct(s.wrongRate),
      pct(s.autoRate),
    ]),
  ),
);
out.push(
  "\nThe 7-oracle median always uses 7 oracle transactions.\n\n![Oracle transactions against u_min](figures/oracle_calls_vs_umin.png)\n",
);
out.push("### Confidence level alpha\n");
out.push(
  table(
    ["alpha", "z (round 1)", "By evidence", "By default", "Wrong", "Oracle txs per event"],
    summary.sweeps.alpha.map((s: Row) => [
      String(s.alpha),
      s.z1.toFixed(3),
      pct(s.autoRate),
      pct(s.defaultRate),
      pct(s.wrongRate),
      s.oracleTxsPerEvent.toFixed(2),
    ]),
  ),
);
out.push("\n![Settled by evidence against alpha](figures/auto_vs_alpha.png)\n");

fs.writeFileSync(path.join(__dirname, "..", "docs", "EXPERIMENTS.md"), out.join("\n") + "\n");
console.log("wrote docs/EXPERIMENTS.md");
