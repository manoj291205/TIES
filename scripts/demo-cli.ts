import { PORTS } from "../services/shared/src";
import type { RoundRow, ScenarioResult } from "../services/demo-server/src/runner";

/**
 * Runs a scenario on the local stack through the demo server and prints every step.
 *   npm run demo:cli -- --scenario compromised-feed
 *   npm run demo:cli -- --list
 */
const base = process.env.DEMO_SERVER_URL ?? `http://127.0.0.1:${PORTS.demoServer}`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const eth = (wei: string) => (Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(4);

function printRound(r: RoundRow) {
  const upper = Number.isFinite(r.upper) ? r.upper.toFixed(1) : "inf";
  console.log(
    `  round ${r.round}: ${r.outcome.padEnd(12)} V=${r.value.toFixed(1)} sigma=${r.sigma.toFixed(1)} ` +
      `N_eff=${r.nEff.toFixed(2)} [L,U]=[${r.lower.toFixed(1)}, ${upper}] ` +
      `cursors=(${r.payCursor}, ${r.noPayCursor}) newPay=${eth(r.newPay)} newNoPay=${eth(r.newNoPay)} held=${eth(r.held)} ETH`,
  );
}

function printResult(r: ScenarioResult) {
  console.log(`\nResult for "${r.scenario}" (event ${r.eventId}, truth ${r.truth})`);
  console.log(`  status: ${r.status}, final value: ${r.finalValue ?? "n/a"}`);
  for (const p of r.policies) {
    const verdict = p.correct === null ? "held" : p.correct ? "correct" : "WRONG";
    console.log(
      `  policy ${p.id} ${p.holder} threshold ${p.bucket} payout ${p.payout} ETH -> ${p.decision} (${verdict})`,
    );
  }
  console.log(
    `  ${r.txCount} transactions (${r.revertedTxs} reverted), ${r.gasTotal} gas in total, ${r.wrongSettlements} wrong settlements`,
  );
  for (const c of r.checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.label} (${c.detail})`);
  console.log(r.ok ? "\nScenario OK" : "\nScenario did NOT meet its expectations");
}

async function main() {
  if (process.argv.includes("--list")) {
    const list = (await (await fetch(`${base}/scenarios`)).json()) as {
      name: string;
      title: string;
    }[];
    for (const s of list) console.log(`${s.name.padEnd(22)} ${s.title}`);
    return;
  }
  const scenario = arg("scenario");
  if (!scenario) {
    console.error("usage: npm run demo:cli -- --scenario <name>   (or --list)");
    process.exit(2);
  }
  const res = await fetch(`${base}/scenarios/${scenario}/run`, { method: "POST" });
  if (!res.ok || !res.body) {
    console.error(`demo server answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  let result: ScenarioResult | undefined;
  let failed: string | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      const body = JSON.parse(data);
      if (event === "log") console.log(`# ${body.message}`);
      else if (event === "step" && body.status === "failed") {
        console.log(
          `  [${body.status}] ${body.label} ${body.hash ? body.hash.slice(0, 12) + "…" : ""} gas ${body.gasUsed ?? "-"}`,
        );
      } else if (event === "tx") {
        const t = body.tx;
        console.log(
          `  tx ${t.status === "reverted" ? "REVERTED" : "mined   "} block ${t.block} ${t.role.padEnd(14)} ${t.contract}.${t.method} gas ${t.gasUsed} ${t.hash.slice(0, 12)}…`,
        );
      } else if (event === "round") printRound(body.round);
      else if (event === "result") result = body.result;
      else if (event === "error" || event === "failed") failed = body.message;
    }
  }
  if (failed) {
    console.error(`\nscenario failed: ${failed}`);
    process.exit(1);
  }
  if (result) {
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
