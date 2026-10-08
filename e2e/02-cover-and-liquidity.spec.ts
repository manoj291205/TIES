import { expect, test } from "@playwright/test";
import { parseEther } from "ethers";
import {
  ACCOUNT,
  address,
  chain,
  ethOf,
  expectConfirmed,
  expectNoErrors,
  openAs,
  until,
} from "./helpers";

test.describe("vault", () => {
  test("an LP deposits and withdraws through the vault screen", async ({ browser }) => {
    const { vault } = chain();
    const lp = await address(ACCOUNT.lp);
    const o = await openAs(browser, ACCOUNT.lp, "vault");
    const before = (await vault.totalAssets()) as bigint;

    await o.page.getByLabel("Amount").first().fill("40");
    await o.page.getByRole("button", { name: "Deposit", exact: true }).click();
    await expectConfirmed(o.page);
    await until(
      async () => ((await vault.totalAssets()) as bigint) === before + parseEther("40"),
      "deposit",
    );

    const sharesBefore = (await vault.sharesOf(lp)) as bigint;
    await o.page.getByLabel("Amount").nth(1).fill("1");
    await o.page.getByRole("button", { name: "Withdraw", exact: true }).click();
    await until(async () => ((await vault.sharesOf(lp)) as bigint) < sharesBefore, "withdraw");
    expect(ethOf((await vault.totalAssets()) as bigint)).toBeCloseTo(ethOf(before) + 39, 3);

    // More than the LP owns cannot be withdrawn: the form says so before anything is sent.
    await o.page.getByLabel("Amount").nth(1).fill("100000");
    await expect(o.page.getByRole("button", { name: "Withdraw", exact: true })).toBeDisabled();
    await expect(o.page.getByText(/at most|exceeds|more than/i).first()).toBeVisible();
    expectNoErrors(o);
    await o.close();
  });
});

test.describe("buying cover", () => {
  test("the quote, threshold and capacity checks work and a policy is bound", async ({
    browser,
  }) => {
    const { book } = chain();
    const holder = await address(ACCOUNT.holder);
    const o = await openAs(browser, ACCOUNT.holder, "buy/1");
    const slider = o.page.getByRole("slider", { name: "Trigger threshold" });
    const start = Number(await slider.getAttribute("aria-valuenow"));
    await slider.focus();
    for (let i = 0; i < 5; i++) await o.page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", String(start + 5));

    // Too large a payout is refused with a reason before MetaMask is ever asked.
    await o.page.getByLabel("Payout if triggered").fill("50");
    await expect(o.page.getByRole("button", { name: "Buy cover" })).toBeDisabled();
    await expect(o.page.getByRole("alert").first()).toBeVisible();

    await o.page.getByLabel("Payout if triggered").fill("0.5");
    const quote = (await book.quote(1, start + 5, parseEther("0.5"))) as bigint;
    const shown = o.page
      .getByText("Premium (contract quote)")
      .locator("xpath=following-sibling::*[1]");
    await expect
      .poll(async () => Math.abs(parseFloat((await shown.textContent()) ?? "0") - ethOf(quote)))
      .toBeLessThan(0.0001);
    await expect(o.page.getByText(/gas/).first()).toBeVisible();

    const count = (await book.policyCount()) as bigint;
    await o.page.getByRole("button", { name: "Buy cover" }).click();
    await expectConfirmed(o.page);
    const id = await until(async () => {
      const n = (await book.policyCount()) as bigint;
      return n > count ? n : 0n;
    }, "the new policy");
    const p = await book.getPolicy(id);
    expect(p.holder).toBe(holder);
    expect(Number(p.bucket)).toBe(start + 5);
    expect(p.premium).toBe(quote);

    await o.page.getByRole("button", { name: "View in My policies" }).click();
    await expect(o.page.locator("h1").first()).toHaveText("My policies");
    await expect(o.page.getByText(`≥ ${start + 5} min`).first()).toBeVisible();
    expectNoErrors(o);
    await o.close();
  });

  test("a second holder buys cover on the rainfall event", async ({ browser }) => {
    const { book } = chain();
    const o = await openAs(browser, ACCOUNT.holder2, "buy/4");
    await expect(o.page.locator("h1").first()).toHaveText(/Chennai/);
    await o.page.getByLabel("Payout if triggered").fill("0.3");
    const count = (await book.policyCount()) as bigint;
    await o.page.getByRole("button", { name: "Buy cover" }).click();
    await expectConfirmed(o.page);
    await until(async () => ((await book.policyCount()) as bigint) > count, "rain policy");
    expectNoErrors(o);
    await o.close();
  });

  test("my policies lists every policy of the account", async ({ browser }) => {
    const { book } = chain();
    const holder = await address(ACCOUNT.holder);
    const ids = (await book.policiesOf(holder)) as bigint[];
    const o = await openAs(browser, ACCOUNT.holder, "policies");
    await expect(o.page.getByRole("row")).toHaveCount(ids.length + 1);
    await expect(o.page.getByText("Active cover").first()).toBeVisible();
    expectNoErrors(o);
    await o.close();
  });
});
