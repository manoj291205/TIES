import { expect, test } from "@playwright/test";
import { ACCOUNT, demo, expectNoErrors, openAs } from "./helpers";

test.describe("app shell and wallet", () => {
  test("every navigation entry opens its screen", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.admin, "markets");
    const nav: [string, RegExp][] = [
      ["Events", /^Events$/],
      ["Buy cover", /AI 101|Chennai|6E|UK 811/],
      ["My policies", /My policies/],
      ["Settlement explorer", /AI 101|Chennai|6E|UK 811/],
      ["Transaction log", /Transaction & event log/],
      ["Vault", /^Vault$/],
      ["Registry & params", /Registry & parameters/],
      ["Disputes", /^Disputes$/],
      ["Live demo lab", /Live demo lab/],
      ["Presenter", /Presenter control panel/],
      ["Docs & FAQ", /Docs & FAQ/],
    ];
    for (const [link, heading] of nav) {
      await o.page.getByRole("link", { name: link, exact: true }).first().click();
      await expect(o.page.locator("h1").first()).toHaveText(heading);
    }
    expectNoErrors(o);
    await o.close();
  });

  test("operator console is reachable for an oracle key", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.oracleN1, "markets");
    await o.page.getByRole("button", { name: "Operator" }).click();
    await o.page.getByRole("link", { name: "Operator console", exact: true }).click();
    await expect(o.page.locator("h1").first()).toHaveText("Operator console");
    expectNoErrors(o);
    await o.close();
  });

  test("theme toggle switches light and dark", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.holder, "markets");
    const html = o.page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");
    await o.page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await o.page.getByRole("button", { name: "Light", exact: true }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await o.close();
  });

  test("the block indicator follows new blocks", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.holder, "markets");
    const indicator = o.page.getByText(/Live\s*·\s*#[\d,]+/).first();
    await expect(indicator).toBeVisible();
    // The number is shown with thousands separators, e.g. #1,284.
    const blockShown = async () =>
      Number((await indicator.textContent())!.match(/#([\d,]+)/)![1].replace(/,/g, ""));
    const before = await blockShown();
    await demo("POST", "/mine", { blocks: 3 });
    await expect.poll(blockShown).toBeGreaterThanOrEqual(before + 3);
    await o.close();
  });

  test("without a wallet the app still reads the chain and explains how to connect", async ({
    browser,
  }) => {
    const o = await openAs(browser, null, "markets");
    await expect(o.page.getByText("MetaMask was not found in this browser")).toBeVisible();
    await expect(o.page.getByRole("link", { name: "Get MetaMask" })).toBeVisible();
    await expect(o.page.getByText("AI 101 DEL-BOM").first()).toBeVisible();
    await o.page.goto("/#/operator");
    await expect(o.page.locator("h1").first()).toHaveText("Operator console");
    expectNoErrors(o);
    await o.close();
  });

  test("connect asks the wallet for accounts and switches it to the local chain", async ({
    browser,
  }) => {
    // A fresh MetaMask: not connected yet and sitting on Ethereum mainnet.
    const o = await openAs(browser, ACCOUNT.holder, "markets", {
      connected: false,
      chainHex: "0x1",
    });
    await o.page.getByRole("button", { name: "Connect MetaMask" }).first().click();
    await expect(o.page.getByText(/0x15d3…6A65/i).first()).toBeVisible();
    const calls = await o.page.evaluate(
      () => (window as unknown as { __wallet: { calls: string[] } }).__wallet.calls,
    );
    expect(calls).toContain("eth_requestAccounts");
    expect(calls).toContain("wallet_switchEthereumChain");
    await expect(o.page.getByText("Your wallet is on an unsupported network")).toHaveCount(0);
    expectNoErrors(o);
    await o.close();
  });

  test("a wallet on another network gets a switch button", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.holder, "markets", { chainHex: "0x1" });
    await expect(o.page.getByText("Your wallet is on an unsupported network")).toBeVisible();
    await o.page.getByRole("button", { name: /Switch to Hardhat Localhost/ }).click();
    await expect(o.page.getByText("Your wallet is on an unsupported network")).toHaveCount(0);
    await o.close();
  });
});

test.describe("landing, events and docs", () => {
  test("landing shows live numbers and links onward", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.holder, "");
    await expect(o.page.getByText("Events open").first()).toBeVisible();
    await expect(o.page.getByText(/ETH in vault/i).first()).toBeVisible();
    await o.page.getByRole("button", { name: "Browse events" }).click();
    await expect(o.page.locator("h1").first()).toHaveText("Events");
    await o.page.goto("/#/");
    await o.page.getByRole("button", { name: "How it works" }).click();
    await expect(o.page.locator("h1").first()).toHaveText(/Docs & FAQ|How it works|Insurance/);
    expectNoErrors(o);
    await o.close();
  });

  test("events can be filtered and searched", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.holder, "markets");
    const cards = o.page.getByRole("button", { name: "Buy cover" });
    await expect(cards).toHaveCount(4);
    await o.page.getByRole("button", { name: "Weather", exact: true }).click();
    await expect(cards).toHaveCount(1);
    await o.page.getByRole("button", { name: "Flight", exact: true }).click();
    await expect(cards).toHaveCount(3);
    await o.page.getByRole("button", { name: "All", exact: true }).first().click();
    await o.page.getByRole("textbox").first().fill("UK 811");
    await expect(cards).toHaveCount(1);
    await o.page.getByRole("textbox").first().fill("");
    await o.page.getByRole("button", { name: "Settled", exact: true }).click();
    await expect(cards).toHaveCount(0);
    await o.page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(cards).toHaveCount(4);
    await cards.first().click();
    await expect(o.page).toHaveURL(/#\/buy\/\d+/);
    expectNoErrors(o);
    await o.close();
  });

  test("docs offer to add the networks to MetaMask", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.holder, "docs");
    await o.page.getByRole("button", { name: "Add Hardhat Localhost to MetaMask" }).click();
    await expect
      .poll(() =>
        o.page.evaluate(
          () => (window as unknown as { __wallet: { calls: string[] } }).__wallet.calls,
        ),
      )
      .toEqual(expect.arrayContaining([expect.stringMatching(/wallet_(add|switch)EthereumChain/)]));
    expectNoErrors(o);
    await o.close();
  });
});
