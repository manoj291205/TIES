import { expect, test } from "@playwright/test";
import { ACCOUNT, demo, expectNoErrors, openAs } from "./helpers";

/** Each scenario creates its own event and plays it to the end with real transactions. */
const SCENARIOS: [string, string][] = [
  ["Honest sources", "honest"],
  ["Compromised feed", "compromised-feed"],
  ["Two keys, one feed", "two-keys-one-feed"],
  ["Noisy source", "noisy-source"],
  ["Late source", "late-source"],
  ["Silent source", "silent-source"],
  ["Unavailable source", "unavailable-source"],
  ["Borderline value", "borderline"],
  ["Forged report", "forged-report"],
  ["Inconsistent rounds", "inconsistent-rounds"],
  ["Challenged default", "challenged-default"],
];

test.describe("live demo lab", () => {
  for (const [label, name] of SCENARIOS) {
    test(`runs the ${name} scenario with real transactions`, async ({ browser }) => {
      test.setTimeout(300_000);
      const started = new Date().toISOString();
      const o = await openAs(browser, ACCOUNT.admin, "lab");
      await o.page.getByRole("button", { name: label, exact: true }).click();
      await o.page.getByRole("button", { name: "Run", exact: true }).click();
      const steps = o.page.getByRole("table", { name: "Transactions" }).getByRole("row");
      await expect(steps.nth(1)).toBeVisible({ timeout: 60_000 });
      await expect(o.page.getByText(/^(As expected|Not as expected)$/)).toBeVisible({
        timeout: 240_000,
      });
      await expect(o.page.getByText("As expected", { exact: true })).toBeVisible();
      await expect(o.page.getByText(/Event ended/)).toBeVisible();
      expect(await o.page.getByText("Fail", { exact: true }).count()).toBe(0);
      // The run history (newest first, last 50 kept) records this run.
      const [latest] = await demo<{ at: string; scenario: string; ok: boolean }[]>("GET", "/runs");
      expect(latest.scenario).toBe(name);
      expect(latest.ok).toBe(true);
      expect(latest.at >= started).toBe(true);
      expectNoErrors(o);
      await o.close();
    });
  }

  test("shows the experiment comparison and its sweeps", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.admin, "lab");
    await expect(o.page.getByText("TIES against the baselines")).toBeVisible();
    await expect(o.page.getByRole("cell", { name: "Single oracle" }).first()).toBeVisible();
    expectNoErrors(o);
    await o.close();
  });

  test("runs the full experiments from the lab (E2E_FULL=1, about 15 minutes)", async ({
    browser,
  }) => {
    test.skip(!process.env.E2E_FULL, "set E2E_FULL=1 to include the 15-minute experiment run");
    test.setTimeout(30 * 60_000);
    const o = await openAs(browser, ACCOUNT.admin, "lab");
    await o.page.getByRole("button", { name: "Run experiments" }).click();
    await expect(o.page.getByText(/scenario|events|%/).first()).toBeVisible({ timeout: 60_000 });
    await expect(o.page.getByText(/done|finished|complete/i).first()).toBeVisible({
      timeout: 29 * 60_000,
    });
    await o.close();
  });
});
