import { expect, test } from "@playwright/test";
import {
  ACCOUNT,
  STATUS,
  address,
  advanceTo,
  chain,
  demo,
  eventStatus,
  expectConfirmed,
  expectNoErrors,
  openAs,
  until,
} from "./helpers";

test.describe("operator console", () => {
  test.beforeAll(async () => {
    await demo("POST", "/keeper/pause");
    await demo("POST", "/nodes/n1/stop"); // key #10 reports by hand in this test
  });
  test.afterAll(async () => {
    await demo("POST", "/nodes/n1/start");
    await demo("POST", "/keeper/resume");
  });

  test("an oracle fetches, commits and reveals a report by hand", async ({ browser }) => {
    const { engine, book } = chain();
    const me = await address(ACCOUNT.oracleN1);
    const o = await openAs(browser, ACCOUNT.oracleN1, "operator");
    await expect(o.page.getByText("Airline status API (S1)")).toBeVisible();
    await expect(o.page.getByText("http://127.0.0.1:7101/mcp")).toBeVisible();

    // Open round 1 of UK 811 (event 3); key #10 is on the committee.
    await advanceTo(Number((await book.eventMeta(3)).observationEnd));
    const x = await openAs(browser, ACCOUNT.holder, "explorer/3");
    await x.page.getByRole("button", { name: "Open round 1" }).click();
    await expectConfirmed(x.page);
    await x.close();
    await until(async () => (await eventStatus(3)) === STATUS.COMMIT, "round 1 of event 3");

    await expect(o.page.getByText("Needs a report").first()).toBeVisible();
    await o.page.getByRole("button", { name: "Fetch and commit" }).click();
    await expectConfirmed(o.page);
    await until(
      async () => (await engine.commitOf(3, 1, me)) !== `0x${"0".repeat(64)}`,
      "the commit",
    );
    await expect(o.page.getByText("Committed").first()).toBeVisible();

    const st = await engine.eventState(3);
    await advanceTo(Number(st.commitDeadline));
    const reveal = o.page.getByRole("button", { name: "Reveal" });
    await expect(reveal).toBeVisible();
    await o.page
      .getByRole("button", { name: "Dismiss" })
      .first()
      .click()
      .catch(() => undefined);
    await reveal.click();
    await expectConfirmed(o.page);
    const mine = await until(async () => {
      const n = Number(await engine.reportCount(3));
      for (let i = 0; i < n; i++) {
        const r = await engine.reportAt(3, i);
        if (String(r.oracle).toLowerCase() === me.toLowerCase()) return r;
      }
      return null;
    }, "the revealed report");
    expect(Number(mine.sourceId)).toBe(1);
    expect(Number(mine.value) / 1000).toBeGreaterThan(85);
    expect(Number(mine.value) / 1000).toBeLessThan(105);
    await expect(o.page.getByText("Revealed").first()).toBeVisible();

    // Finish the event so the history and reputation update.
    await advanceTo(Number(st.revealDeadline));
    await demo("POST", "/keeper/resume");
    await until(
      async () => (await eventStatus(3)) >= STATUS.DEFAULT_PENDING,
      "the round to close",
      90_000,
    );
    expectNoErrors(o);
    await o.close();
  });

  test("an account that is not an oracle is told so", async ({ browser }) => {
    const o = await openAs(browser, ACCOUNT.holder, "operator");
    await expect(o.page.getByText("This account is not a registered oracle")).toBeVisible();
    expectNoErrors(o);
    await o.close();
  });
});
