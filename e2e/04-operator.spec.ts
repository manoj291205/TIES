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
  provider,
  until,
} from "./helpers";

test.describe("operator console", () => {
  let eventId = 0;
  test.beforeAll(async () => {
    // Key #10 reports by hand here, so both nodes that use it (n1 flight, n9 rain) stop first.
    await demo("POST", "/nodes/n1/stop");
    await demo("POST", "/nodes/n9/stop");
    await demo("POST", "/keeper/pause");
    // A fresh event, so no earlier test or the keeper can have opened its round already.
    const { book } = chain();
    const admin = await provider.getSigner(await address(ACCOUNT.admin));
    const now = (await provider.getBlock("latest"))!.timestamp;
    await (
      await (book.connect(admin) as typeof book).createEvent(
        0,
        "UK 811 BOM-MAA (operator test)",
        "UK811|2026-10-13",
        now + 600,
        now + 1200,
      )
    ).wait();
    eventId = Number(await book.eventCount());
  });
  test.afterAll(async () => {
    await demo("POST", "/nodes/n1/start");
    await demo("POST", "/nodes/n9/start");
    await demo("POST", "/keeper/resume");
  });

  test("an oracle fetches, commits and reveals a report by hand", async ({ browser }) => {
    const { engine, book } = chain();
    const me = await address(ACCOUNT.oracleN1);
    const o = await openAs(browser, ACCOUNT.oracleN1, "operator");
    await expect(o.page.getByText("Airline status API (S1)")).toBeVisible();
    await expect(o.page.getByText("http://127.0.0.1:7101/mcp")).toBeVisible();

    // Open round 1 of the new event; key #10 is on the flight committee.
    await advanceTo(Number((await book.eventMeta(eventId)).observationEnd));
    const x = await openAs(browser, ACCOUNT.holder, `explorer/${eventId}`);
    await x.page.getByRole("button", { name: "Open round 1" }).click();
    await expectConfirmed(x.page);
    await x.close();
    await until(async () => (await eventStatus(eventId)) === STATUS.COMMIT, "round 1");

    await expect(
      o.page
        .getByRole("row")
        .filter({ hasText: "UK 811 BOM-MAA (operator test)" })
        .getByText("Needs a report"),
    ).toBeVisible();
    const row = o.page.getByRole("row").filter({ hasText: "UK 811 BOM-MAA (operator test)" });
    await row.getByRole("button", { name: "Fetch and commit" }).click();
    await expectConfirmed(o.page);
    await until(
      async () => (await engine.commitOf(eventId, 1, me)) !== `0x${"0".repeat(64)}`,
      "the commit",
    );
    await expect(o.page.getByText("Committed").first()).toBeVisible();

    const st = await engine.eventState(eventId);
    await advanceTo(Number(st.commitDeadline));
    const reveal = row.getByRole("button", { name: "Reveal" });
    await expect(reveal).toBeVisible();
    await o.page
      .getByRole("button", { name: "Dismiss" })
      .first()
      .click()
      .catch(() => undefined);
    await reveal.click();
    await expectConfirmed(o.page);
    const mine = await until(async () => {
      const n = Number(await engine.reportCount(eventId));
      for (let i = 0; i < n; i++) {
        const r = await engine.reportAt(eventId, i);
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
      async () => (await eventStatus(eventId)) >= STATUS.DEFAULT_PENDING,
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
