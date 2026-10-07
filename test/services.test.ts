import { expect } from "chai";
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DeploymentWatcher,
  SOURCES,
  makeLogger,
  makeProvider,
  repoRoot,
  waitForRpc,
} from "../services/shared/src";
import { startSources, RunningSources } from "../services/sources/src";
import { OracleService, startOracleService } from "../services/oracle-node/src/service";
import { Keeper, startKeeper } from "../services/keeper/src/keeper";
import { DemoServer } from "../services/demo-server/src/server";
import { RunEvent, ScenarioRunner } from "../services/demo-server/src/runner";
import { deployAndSeed } from "../scripts/lib/stack";

/**
 * Starts the real services (sources with MCP, oracle nodes, keeper, scenario runner) in this
 * process against a separate Hardhat node and plays scenarios end to end. Ports are shifted so a
 * running dev stack is not disturbed.
 */
describe("Off-chain services (integration)", function () {
  this.timeout(600_000);

  const RPC_PORT = 8599;
  const rpcUrl = `http://127.0.0.1:${RPC_PORT}`;
  const SOURCE_OFFSET = 300;
  const ORACLE_PORT = 7500;
  const DEMO_PORT = 7600;

  let node: ChildProcess;
  let tmp: string;
  let sources: RunningSources;
  let oracles: OracleService;
  let keeper: Keeper;
  let demo: DemoServer;
  let runner: ScenarioRunner;
  const provider = makeProvider(rpcUrl, 31337);

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ties-it-"));
    process.env.TIES_DEPLOYMENTS_DIR = tmp;

    const hardhatBin = path.join(
      repoRoot(),
      "node_modules",
      "hardhat",
      "internal",
      "cli",
      "bootstrap.js",
    );
    node = spawn(process.execPath, [hardhatBin, "node", "--port", String(RPC_PORT)], {
      cwd: repoRoot(),
      stdio: "ignore",
    });
    await waitForRpc(provider, 90_000);
    await deployAndSeed(provider, { events: false });

    sources = await startSources({ rpcUrl, portOffset: SOURCE_OFFSET });
    oracles = await startOracleService({
      rpcUrl,
      port: ORACLE_PORT,
      sourcePortOffset: SOURCE_OFFSET,
    });
    keeper = startKeeper({ rpcUrl, pollMs: 300 });

    const urls = {
      source: (id: number) =>
        `http://127.0.0.1:${SOURCES.find((s) => s.id === id)!.port + SOURCE_OFFSET}`,
      oracle: `http://127.0.0.1:${ORACLE_PORT}`,
    };
    const log = makeLogger("it");
    const deployments = new DeploymentWatcher(31337);
    runner = new ScenarioRunner(provider, deployments, log, urls);
    demo = new DemoServer(provider, deployments, log, urls);
    await demo.listen(DEMO_PORT);
  });

  after(async () => {
    keeper?.stop();
    oracles?.stop();
    demo?.close();
    await sources?.close();
    provider.destroy();
    node?.kill();
    delete process.env.TIES_DEPLOYMENTS_DIR;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function play(name: string) {
    const events: RunEvent[] = [];
    const result = await runner.run(name, (e) => events.push(e));
    return { result, events };
  }

  it("serves the scenario list over the demo server", async () => {
    const res = await fetch(`http://127.0.0.1:${DEMO_PORT}/scenarios`);
    const list = (await res.json()) as { name: string }[];
    expect(list.map((s) => s.name)).to.include.members([
      "honest",
      "compromised-feed",
      "forged-report",
    ]);
  });

  it("settles an honest event in one round with no wrong settlement", async () => {
    const { result } = await play("honest");
    expect(
      result.checks.filter((c) => !c.pass),
      JSON.stringify(result.checks),
    ).to.have.length(0);
    expect(result.status).to.equal("FINAL");
    expect(result.rounds).to.have.length(1);
    expect(result.rounds[0].outcome).to.equal("VALID");
    expect(result.wrongSettlements).to.equal(0);
  });

  it("moves no money on one compromised feed read by two keys, then outvotes it", async () => {
    const { result } = await play("compromised-feed");
    expect(result.rounds[0].outcome).to.equal("INSUFFICIENT");
    expect(result.rounds[0].newPay).to.equal("0");
    expect(result.rounds[0].newNoPay).to.equal("0");
    expect(result.rounds.length).to.be.greaterThan(1);
    expect(result.status).to.equal("FINAL");
    expect(result.wrongSettlements).to.equal(0);
  });

  it("rejects a forged report: the tampered reveal reverts and never counts", async () => {
    const { result } = await play("forged-report");
    expect(result.revertedTxs).to.be.greaterThan(0);
    expect(result.status).to.equal("FINAL");
    expect(result.wrongSettlements).to.equal(0);
  });
});
