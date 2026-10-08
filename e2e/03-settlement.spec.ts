import { expect, test, type Page } from "@playwright/test";
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

/** Waits until every committee member's oracle node has committed (or revealed) for the round. */
async function nodesDone(eventId: number, round: number, states: string[]): Promise<void> {
  const committee = (await chain().engine.committeeOf(eventId, round)) as string[];
  await until(
    async () => {
      const { nodes } = await demo<{
        nodes: { address: string; tasks: { eventId: number; round: number; state: string }[] }[];
      }>("GET", "/nodes");
      return committee.every((m) =>
        nodes
          .filter((n) => n.address.toLowerCase() === m.toLowerCase())
          .some((n) =>
            n.tasks.some(
              (t) => t.eventId === eventId && t.round === round && states.includes(t.state),
            ),
          ),
      );
    },
    `oracle nodes to reach ${states.join("/")} on event ${eventId} round ${round}`,
  );
}

/** Plays rounds by hand from the explorer until the event leaves the round states. */
async function playRoundsByHand(page: Page, eventId: number): Promise<void> {
  const { engine } = chain();
  for (let i = 0; i < 4; i++) {
    const st = await engine.eventState(eventId);
    if (![STATUS.COMMIT, STATUS.REVEAL].includes(Number(st.status))) return;
    const round = Number(st.round);
    await nodesDone(eventId, round, ["committed", "revealed", "silent"]);
    await advanceTo(Number(st.commitDeadline));
    await nodesDone(eventId, round, ["revealed", "silent", "reveal_failed"]);
    await advanceTo(Number(st.revealDeadline));
    const finalize = page.getByRole("button", { name: "Settle now" });
    await expect(finalize).toBeEnabled();
    await finalize.click();
    await expectConfirmed(page);
    await until(
      async () =>
        Number((await engine.eventState(eventId)).round) !== round ||
        (await eventStatus(eventId)) > STATUS.REVEAL,
      "the round to close",
    );
    await page
      .getByRole("button", { name: "Dismiss" })
      .first()
      .click()
      .catch(() => undefined);
  }
}

test.describe("settlement by hand", () => {
  test.beforeAll(async () => {
    await demo("POST", "/keeper/pause");
  });
  test.afterAll(async () => {
    await demo("POST", "/keeper/resume");
  });

  test("open, finalize, challenge and resolve AI 101 from the screens", async ({ browser }) => {
    const { engine, book } = chain();
    const o = await openAs(browser, ACCOUNT.holder, "explorer/1");
    await expect(o.page.getByRole("button", { name: "Full 0–720" })).toBeVisible();
    await o.page.getByRole("button", { name: "View as table" }).click();
    await expect(o.page.getByRole("table").first()).toBeVisible();

    // Before the observation window ends nobody can open the round.
    const open = o.page.getByRole("button", { name: "Open round 1" });
    await expect(open).toBeDisabled();
    const meta = await book.eventMeta(1);
    await advanceTo(Number(meta.observationEnd));
    await expect(open).toBeEnabled();
    await open.click();
    await expectConfirmed(o.page);
    await until(async () => (await eventStatus(1)) === STATUS.COMMIT, "round 1 to open");
    await o.page.getByRole("button", { name: "Dismiss" }).first().click();

    await playRoundsByHand(o.page, 1);
    expect(await eventStatus(1)).toBe(STATUS.DEFAULT_PENDING);
    await expect(o.page.getByText(/Default pending|challenge/i).first()).toBeVisible();
    expectNoErrors(o);
    await o.close();

    // The challenger posts the bond from the explorer.
    const c = await openAs(browser, ACCOUNT.challenger, "explorer/1");
    await c.page.getByRole("button", { name: "Challenge (0.05 ETH bond)" }).click();
    await expectConfirmed(c.page);
    await until(async () => (await eventStatus(1)) === STATUS.DISPUTED, "the dispute");
    expectNoErrors(c);
    await c.close();

    // The admin resolves it from the disputes queue, far enough from V that the bond is returned.
    const challenger = await address(ACCOUNT.challenger);
    const before = await provider.getBalance(challenger);
    const a = await openAs(browser, ACCOUNT.admin, "disputes");
    await expect(a.page.getByText("Challenged default")).toBeVisible();
    await a.page.getByLabel(/Final value/).fill("150");
    await expect(a.page.getByText("What this would move")).toBeVisible();
    await a.page.getByRole("button", { name: "Resolve" }).click();
    await a.page.getByRole("button", { name: /Confirm: resolve at 150/ }).click();
    await expectConfirmed(a.page);
    await until(async () => (await eventStatus(1)) === STATUS.FINAL, "the event to be final");
    expect((await provider.getBalance(challenger)) - before).toBe(50_000_000_000_000_000n);
    expect(Number((await engine.eventState(1)).lowerBound)).toBe(150_000);
    expectNoErrors(a);
    await a.close();
  });

  test("a pending default is applied from the disputes screen", async ({ browser }) => {
    const { book } = chain();
    // Truth is 40 min; shift the round-1 sources to about 45 so the 45-minute cover stays held
    // and the event goes to a pending default (source noise alone makes this vary).
    for (const s of ["S1", "S2", "S3"])
      await demo("POST", `/sources/${s}/mode`, { mode: "offset", offset: 5 });
    const meta = await book.eventMeta(2);
    await advanceTo(Number(meta.observationEnd));
    const o = await openAs(browser, ACCOUNT.holder, "explorer/2");
    await o.page.getByRole("button", { name: "Open round 1" }).click();
    await expectConfirmed(o.page);
    await until(async () => (await eventStatus(2)) === STATUS.COMMIT, "round 1 to open");
    await playRoundsByHand(o.page, 2);
    await o.close();
    for (const s of ["S1", "S2", "S3"])
      await demo("POST", `/sources/${s}/mode`, { mode: "honest", offset: 0 });
    expect(await eventStatus(2)).toBe(STATUS.DEFAULT_PENDING);

    const st = await chain().engine.eventState(2);
    const a = await openAs(browser, ACCOUNT.holder2, "disputes");
    const apply = a.page.getByRole("button", { name: "Apply default" });
    await expect(apply).toBeDisabled();
    await advanceTo(Number(st.challengeDeadline));
    await expect(apply).toBeEnabled();
    await apply.click();
    await expectConfirmed(a.page);
    await until(async () => (await eventStatus(2)) === STATUS.FINAL, "the default to apply");
    expectNoErrors(a);
    await a.close();
  });

  test("holders claim what paid, all at once and one by one", async ({ browser }) => {
    const { book, engine } = chain();
    const paid = async (index: number) => {
      const holder = await address(index);
      for (const id of (await book.policiesOf(holder)) as bigint[]) {
        const p = await book.getPolicy(id);
        if (Number(p.bucket) <= Number(await engine.payCursor(p.eventId)))
          expect(p.claimed).toBe(true);
      }
    };

    // Holder #4 has at least two paying policies (more if the cover spec ran first): "Claim all".
    const holder = await address(ACCOUNT.holder);
    const o = await openAs(browser, ACCOUNT.holder, "policies");
    const buttons = o.page.getByRole("button", { name: /^Claim \d/ });
    await expect(buttons.nth(1)).toBeVisible();
    const n = await buttons.count();
    const before = await provider.getBalance(holder);
    await o.page.getByRole("button", { name: `Claim all (${n})` }).click();
    await expect(buttons).toHaveCount(0, { timeout: 60_000 });
    expect((await provider.getBalance(holder)) - before).toBeGreaterThan(900_000_000_000_000_000n);
    await paid(ACCOUNT.holder);
    await expect(o.page.getByText("Claimed").first()).toBeVisible();
    expectNoErrors(o);
    await o.close();

    // Holder #5 claims a single policy with its own button.
    const h2 = await openAs(browser, ACCOUNT.holder2, "policies");
    const one = h2.page.getByRole("button", { name: /^Claim \d/ });
    await expect(one.first()).toBeVisible();
    const m = await one.count();
    await one.first().click();
    await expect(h2.page.getByText(/Claim policy #\d+/).first()).toBeVisible();
    await expect(one).toHaveCount(m - 1, { timeout: 60_000 });
    expectNoErrors(h2);
    await h2.close();
  });
});
