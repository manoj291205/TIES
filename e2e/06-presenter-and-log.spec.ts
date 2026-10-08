import { expect, test } from "@playwright/test";
import {
  ACCOUNT,
  address,
  chain,
  chainTime,
  demo,
  expectNoErrors,
  openAs,
  provider,
  until,
} from "./helpers";

interface SourceRow {
  key: string;
  mode?: string;
  offset?: number;
  down?: boolean;
}
interface NodeRow {
  id: string;
  mode: string;
  running: boolean;
}
const sourceOf = async (key: string) =>
  (await demo<SourceRow[]>("GET", "/sources")).find((s) => s.key === key)!;
const nodeOf = async (id: string) =>
  (await demo<{ nodes: NodeRow[] }>("GET", "/nodes")).nodes.find((n) => n.id === id)!;

test.describe("presenter control panel", () => {
  test("funds accounts and the connected wallet", async ({ browser }) => {
    const spare = await address(ACCOUNT.spare);
    await provider.send("hardhat_setBalance", [spare, "0xde0b6b3a7640000"]); // 1 ETH
    const o = await openAs(browser, ACCOUNT.spare, "presenter");
    await o.page.getByRole("button", { name: "Fund my wallet (100 ETH)" }).click();
    await until(
      async () => (await provider.getBalance(spare)) === 100n * 10n ** 18n,
      "100 ETH on #19",
    );
    await o.page.getByRole("button", { name: "Fund accounts (10,000 ETH)" }).click();
    await until(
      async () => (await provider.getBalance(spare)) === 10_000n * 10n ** 18n,
      "10,000 ETH on #19",
    );
    expectNoErrors(o);
    await o.close();
  });

  test("moves time and mines blocks", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.admin, "presenter");
    const t0 = await chainTime();
    await o.page.getByLabel("Seconds").fill("600");
    await o.page.getByRole("button", { name: "Advance", exact: true }).click();
    await until(async () => (await chainTime()) >= t0 + 600, "time to advance");
    const b0 = await provider.getBlockNumber();
    await o.page.getByRole("button", { name: "Mine block", exact: true }).click();
    await until(async () => (await provider.getBlockNumber()) >= b0 + 1, "one block");
    await o.page.getByRole("button", { name: "Mine 10", exact: true }).click();
    await until(async () => (await provider.getBlockNumber()) >= b0 + 11, "ten blocks");
    // Jump to the selected event's binding cutoff.
    const past = o.page.getByRole("button", { name: "Past binding cutoff" });
    if (await past.isEnabled()) {
      await past.click();
      await expect(o.page.getByText(/Advance \d+s: done/)).toBeVisible();
    }
    expectNoErrors(o);
    await o.close();
  });

  test("switches source and node modes, stops and starts nodes", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.admin, "presenter");
    const s2 = o.page.getByRole("row").filter({ hasText: "S2 · Aggregator A" });
    await s2.getByRole("button", { name: "+90", exact: true }).click();
    await until(async () => (await sourceOf("S2")).mode === "offset", "S2 offset");
    await expect(s2.getByText("+90")).toHaveCount(2);
    await s2.getByRole("button", { name: "Down", exact: true }).click();
    await until(async () => (await sourceOf("S2")).down === true, "S2 down");
    await s2.getByRole("button", { name: "Honest", exact: true }).click();
    await until(async () => {
      const s = await sourceOf("S2");
      return s.mode === "honest" && !s.down;
    }, "S2 honest");

    const n2 = o.page.getByRole("row").filter({ hasText: "n2 · S2" });
    await n2.getByRole("button", { name: "tamper", exact: true }).click();
    await until(async () => (await nodeOf("n2")).mode === "tamper", "n2 tamper");
    await n2.getByRole("button", { name: "honest", exact: true }).click();
    await until(async () => (await nodeOf("n2")).mode === "honest", "n2 honest");
    await n2.getByRole("button", { name: "Stop", exact: true }).click();
    await until(async () => !(await nodeOf("n2")).running, "n2 stopped");
    await n2.getByRole("button", { name: "Start", exact: true }).click();
    await until(async () => (await nodeOf("n2")).running, "n2 running");

    await o.page.getByRole("button", { name: "Pause keeper" }).click();
    await until(
      async () => (await demo<{ paused: boolean }>("GET", "/keeper")).paused,
      "keeper paused",
    );
    await expect(o.page.getByText("Paused")).toBeVisible();
    await o.page.getByRole("button", { name: "Resume keeper" }).click();
    await until(
      async () => !(await demo<{ paused: boolean }>("GET", "/keeper")).paused,
      "keeper running",
    );
    expectNoErrors(o);
    await o.close();
  });
});

test.describe("transaction and event log", () => {
  test("lists contract events, filters them and pauses the feed", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.admin, "log");
    const table = o.page.getByRole("table", { name: "Contract events" });
    await expect(table.getByRole("row").nth(1)).toBeVisible();
    const all = await table.getByRole("row").count();
    await o.page.getByRole("button", { name: "Vault", exact: true }).click();
    await expect.poll(async () => table.getByRole("row").count()).toBeLessThan(all);
    await o.page.getByRole("button", { name: "All", exact: true }).click();
    await o.page.getByRole("button", { name: "Pause feed" }).click();
    await expect(o.page.getByRole("button", { name: /Resume feed|Resume/ })).toBeVisible();
    await o.page.getByRole("button", { name: /Resume feed|Resume/ }).click();
    expectNoErrors(o);
    await o.close();
  });

  test("the explorer's event log link opens the log filtered to that event", async ({
    browser,
  }) => {
    const o = await openAs(browser, ACCOUNT.holder, "explorer/1");
    await o.page.getByRole("button", { name: "Event log" }).click();
    await expect(o.page).toHaveURL(/#\/log\?event=1/);
    await expect(o.page.getByText("Event #1 only")).toBeVisible();
    await o.page.getByRole("button", { name: "Clear filter" }).click();
    await expect(o.page.getByText("Event #1 only")).toHaveCount(0);
    expectNoErrors(o);
    await o.close();
  });
});

test.describe("reset", () => {
  test("reset redeploys the contracts and the app follows without a manual reload", async ({
    browser,
  }) => {
    const before = await chain().engine.getAddress();
    const o = await openAs(browser, ACCOUNT.admin, "presenter");
    await o.page.getByRole("button", { name: "Reset and redeploy" }).click();
    await until(
      async () => (await chain().engine.getAddress()) !== before,
      "a new deployment",
      120_000,
    );
    const after = await chain().engine.getAddress();
    // The sidebar lists the engine address of the deployment the app is using.
    await expect(o.page.getByText(`${after.slice(0, 6)}…${after.slice(-4)}`)).toBeVisible({
      timeout: 30_000,
    });
    await o.page.getByRole("link", { name: "Events", exact: true }).click();
    await expect(o.page.getByRole("button", { name: "Buy cover" })).toHaveCount(4);
    await demo("POST", "/fund");
    await o.close();
  });
});
