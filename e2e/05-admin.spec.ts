import { expect, test } from "@playwright/test";
import { Wallet, parseEther } from "ethers";
import { ACCOUNT, address, chain, expectNoErrors, openAs, until } from "./helpers";

test.describe("admin registry", () => {
  test("a non-admin sees the registry read-only", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.holder, "admin");
    await expect(
      o.page.getByText("Read-only: only the admin account can change these."),
    ).toBeVisible();
    await expect(o.page.getByRole("button", { name: "Save as a new version" })).toHaveCount(0);
    await o.page.getByRole("button", { name: "Create event", exact: true }).click();
    await expect(o.page.getByText("Only the admin can create events")).toBeVisible();
    expectNoErrors(o);
    await o.close();
  });

  test("the admin saves a new parameter version and restores the old value", async ({
    browser,
  }) => {
    const { registry } = chain();
    const versions = Number(await registry.versionCount(0));
    const o = await openAs(browser, ACCOUNT.admin, "admin");
    const trigger = o.page.getByLabel("Escalation trigger (ETH)").first();
    await expect(trigger).toHaveValue("2.0");

    await trigger.fill("abc");
    await expect(
      o.page.getByRole("button", { name: "Save as a new version" }).first(),
    ).toBeDisabled();

    await trigger.fill("2.5");
    await expect(o.page.getByText("Changed: Escalation trigger (ETH)")).toBeVisible();
    await o.page.getByRole("button", { name: "Save as a new version" }).first().click();
    await until(async () => Number(await registry.versionCount(0)) === versions + 1, "version 2");
    expect((await registry.getParams(0, versions)).uMin).toBe(parseEther("2.5"));

    await o.page.reload();
    const again = o.page.getByLabel("Escalation trigger (ETH)").first();
    await expect(again).toHaveValue("2.5");
    await again.fill("2.0");
    await o.page.getByRole("button", { name: "Save as a new version" }).first().click();
    await until(async () => Number(await registry.versionCount(0)) === versions + 2, "version 3");
    expect((await registry.getParams(0, versions + 1)).uMin).toBe(parseEther("2"));
    expectNoErrors(o);
    await o.close();
  });

  test("the admin deactivates, reactivates and registers sources", async ({ browser }) => {
    const { registry } = chain();
    const o = await openAs(browser, ACCOUNT.admin, "admin");
    await o.page.getByRole("button", { name: "Sources", exact: true }).click();
    const row = o.page.getByRole("row").filter({ hasText: "S6" });
    await row.getByRole("button", { name: "Deactivate", exact: true }).click();
    await until(async () => !(await registry.getSource(6)).active, "S6 inactive");
    await expect(row.getByRole("button", { name: "Activate", exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Activate", exact: true }).click();
    await until(async () => (await registry.getSource(6)).active, "S6 active again");

    const count = Number(await registry.sourceCount());
    const signer = Wallet.createRandom().address;
    await o.page.getByLabel("Signer address").fill(signer);
    await o.page.getByLabel("Name", { exact: true }).fill("E2E test source");
    await o.page.getByRole("button", { name: "Register", exact: true }).click();
    await until(async () => Number(await registry.sourceCount()) === count + 1, "the new source");
    expect(Number(await registry.sourceIdOfSigner(signer))).toBe(count + 1);
    // Leave it inactive so it does not change how many sources the category counts.
    const newRow = o.page.getByRole("row").filter({ hasText: "E2E test source" });
    await newRow.getByRole("button", { name: "Deactivate", exact: true }).click();
    await until(async () => !(await registry.getSource(count + 1)).active, "test source inactive");
    expectNoErrors(o);
    await o.close();
  });

  test("the admin edits the oracle allowlist", async ({ browser }) => {
    const { registry } = chain();
    const o = await openAs(browser, ACCOUNT.admin, "admin");
    await o.page.getByRole("button", { name: "Oracles", exact: true }).click();
    const n4 = await address(13); // flight oracle on S4, recruited on escalation
    const row = o.page
      .getByRole("row")
      .filter({ hasText: n4.slice(0, 6) })
      .filter({ hasText: "Flight" });
    await row.getByRole("button", { name: "Add to committee" }).click();
    await until(async () => (await registry.getOracle(n4, 0)).primary, "#13 on the committee");
    await row.getByRole("button", { name: "Remove from committee" }).click();
    await until(async () => !(await registry.getOracle(n4, 0)).primary, "#13 off the committee");

    const spare = await address(ACCOUNT.spare);
    const before = Number(await registry.oracleCount(0));
    await o.page.getByLabel("Oracle address").fill(spare);
    await o.page.getByLabel("Source id").fill("6");
    await o.page.getByRole("button", { name: "Register", exact: true }).click();
    await until(async () => Number(await registry.oracleCount(0)) === before + 1, "the new oracle");
    // No node runs key #19, so disable it again to keep recruitment unchanged.
    const spareRow = o.page.getByRole("row").filter({ hasText: spare.slice(0, 6) });
    await spareRow.getByRole("button", { name: "Disable", exact: true }).click();
    await until(async () => !(await registry.getOracle(spare, 0)).active, "#19 disabled");
    expectNoErrors(o);
    await o.close();
  });

  test("the admin creates an event that is then open for cover", async ({ browser }) => {
    const { book } = chain();
    const count = Number(await book.eventCount());
    const o = await openAs(browser, ACCOUNT.admin, "admin");
    await o.page.getByRole("button", { name: "Create event", exact: true }).click();
    await o.page.getByLabel("Label").fill("QA 999 E2E-TEST 2026-10-12");
    await o.page.getByLabel("Observation key").fill("AI101|2026-10-12");
    await o.page.getByRole("button", { name: "Create event", exact: true }).last().click();
    await until(async () => Number(await book.eventCount()) === count + 1, "the new event");
    expect((await book.eventData(count + 1)).label).toBe("QA 999 E2E-TEST 2026-10-12");
    await o.page.getByRole("link", { name: "Events", exact: true }).click();
    await expect(o.page.getByText("QA 999 E2E-TEST 2026-10-12")).toBeVisible();
    expectNoErrors(o);
    await o.close();
  });
});
