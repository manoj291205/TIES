import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { WAD } from "../packages/ties-math/src";
import { createFlightEvent, eth, FLIGHT_DELAY, RAIN_24H } from "./helpers/deploy";
import {
  bindPolicy,
  commitHash,
  deployEngine,
  findLogs,
  milli,
  openFirstRound,
  OracleSpec,
  playCurrentRound,
  playUntilSettled,
  Responder,
  SALT,
  signReport,
  Stack,
} from "./helpers/engine";

const Status = { NONE: 0, COMMIT: 1, REVEAL: 2, DEFAULT_PENDING: 3, DISPUTED: 4, FINAL: 5 };

/** No oracle can be recruited, so held collateral goes straight to the default path. */
const NO_RECRUIT = { rMin: 2n * WAD };

const prim = (source: number): OracleSpec => ({ source, primary: true });
const cand = (source: number): OracleSpec => ({ source, primary: false });

/** Reports by source id; sources not listed stay silent. */
const bySource =
  (values: Record<number, number>): Responder =>
  ({ source }) =>
    values[source] === undefined ? null : milli(values[source]);

const HONEST = bySource({ 1: 128, 2: 130, 3: 131 });

async function conserved(stack: Stack) {
  const balance = await ethers.provider.getBalance(await stack.vault.getAddress());
  const free = await stack.vault.freeLiquidity();
  expect(free + (await stack.vault.locked()) + (await stack.vault.claimable())).to.equal(balance);
}

async function setup(
  policies: { bucket: number; payout: bigint }[],
  overrides: Parameters<typeof deployEngine>[0] = {},
  oracles: OracleSpec[] = [prim(1), prim(2), prim(3)],
  deposit = eth("100"),
) {
  const stack = await deployEngine(overrides, { oracles });
  await stack.vault.connect(stack.lp1).deposit({ value: deposit });
  const eventId = await createFlightEvent(stack.book);
  for (const p of policies) await bindPolicy(stack, stack.alice, eventId, p.bucket, p.payout);
  await openFirstRound(stack, eventId);
  return { ...stack, eventId };
}

describe("Edge cases", () => {
  it("finalizes an event with no policies at all", async () => {
    const stack = await setup([]);
    await playCurrentRound(stack, stack.eventId, HONEST);
    const st = await stack.engine.eventState(stack.eventId);
    expect(st.status).to.equal(Status.FINAL);
    expect(await stack.engine.held(stack.eventId)).to.equal(0n);
    expect(await stack.vault.locked()).to.equal(0n);
    expect(await stack.vault.claimable()).to.equal(0n);
    await conserved(stack);
  });

  it("settles every policy of a single bucket together when the interval clears it", async () => {
    const stack = await setup(Array.from({ length: 5 }, () => ({ bucket: 120, payout: eth("1") })));
    await playCurrentRound(stack, stack.eventId, HONEST);
    expect((await stack.engine.eventState(stack.eventId)).status).to.equal(Status.FINAL);
    expect(await stack.vault.claimable()).to.equal(eth("5"));
    for (let id = 1; id <= 5; id++) await stack.book.connect(stack.alice).claim(id);
    expect(await stack.vault.claimable()).to.equal(0n);
    await conserved(stack);
  });

  it("holds a single bucket inside the interval and settles all of it by the default", async () => {
    const stack = await setup(
      Array.from({ length: 5 }, () => ({ bucket: 130, payout: eth("1") })),
      NO_RECRUIT,
    );
    await playCurrentRound(stack, stack.eventId, HONEST);
    let st = await stack.engine.eventState(stack.eventId);
    expect(st.status).to.equal(Status.DEFAULT_PENDING);
    expect(await stack.engine.held(stack.eventId)).to.equal(eth("5"));
    await time.increaseTo(Number(st.challengeDeadline));
    await stack.engine.applyDefault(stack.eventId);
    st = await stack.engine.eventState(stack.eventId);
    expect(st.status).to.equal(Status.FINAL);
    // The consensus is just below 130 minutes, so the whole bucket does not pay.
    expect(st.lowerBound).to.be.lt(milli(130));
    expect(await stack.vault.locked()).to.equal(0n);
    expect(await stack.vault.claimable()).to.equal(0n);
    await conserved(stack);
  });

  it("handles a value of zero: the zero bucket pays and the top bucket does not", async () => {
    const stack = await setup([
      { bucket: 0, payout: eth("1") },
      { bucket: 720, payout: eth("2") },
    ]);
    await playCurrentRound(stack, stack.eventId, bySource({ 1: 0, 2: 0, 3: 0 }));
    const st = await stack.engine.eventState(stack.eventId);
    expect(st.status).to.equal(Status.FINAL);
    expect(st.lowerBound).to.equal(0n);
    expect(await stack.engine.payCursor(stack.eventId)).to.equal(0n);
    expect(await stack.vault.claimable()).to.equal(eth("1"));
    expect(await stack.vault.locked()).to.equal(0n);
    await conserved(stack);
  });

  it("handles values at and beyond the top bucket: every bucket pays", async () => {
    const stack = await setup([
      { bucket: 0, payout: eth("1") },
      { bucket: 720, payout: eth("2") },
    ]);
    await playCurrentRound(stack, stack.eventId, bySource({ 1: 900, 2: 901, 3: 902 }));
    const st = await stack.engine.eventState(stack.eventId);
    expect(st.status).to.equal(Status.FINAL);
    expect(await stack.engine.payCursor(stack.eventId)).to.equal(720n);
    expect(await stack.engine.noPayCursor(stack.eventId)).to.equal(721n);
    expect(await stack.vault.claimable()).to.equal(eth("3"));
    await stack.book.connect(stack.alice).claim(2);
    await conserved(stack);
  });

  it("keeps everything locked when every oracle stays silent, then the admin resolves", async () => {
    const stack = await setup([{ bucket: 120, payout: eth("2") }], {}, [
      prim(1),
      prim(2),
      prim(3),
      cand(4),
      cand(5),
    ]);
    const receipts = await playUntilSettled(stack, stack.eventId, () => null);
    expect(receipts.length).to.be.lte(3);
    const st = await stack.engine.eventState(stack.eventId);
    expect(st.status).to.equal(Status.DISPUTED);
    expect(st.disputeReason).to.equal(2); // INSUFFICIENT_EVIDENCE
    expect(await stack.vault.locked()).to.equal(eth("2"));
    expect(await stack.engine.held(stack.eventId)).to.equal(eth("2"));

    const [, betaBefore] = await stack.registry.reputation(stack.oracles[0].address, FLIGHT_DELAY);
    await stack.engine.connect(stack.admin).resolveDispute(stack.eventId, milli(150));
    expect((await stack.engine.eventState(stack.eventId)).status).to.equal(Status.FINAL);
    expect(await stack.vault.claimable()).to.equal(eth("2"));
    // Silent committee members are penalised by the learning update.
    const [, betaAfter] = await stack.registry.reputation(stack.oracles[0].address, FLIGHT_DELAY);
    expect(betaAfter).to.be.gt(betaBefore);
    await conserved(stack);
  });

  it("defaults without escalating when every candidate's source is already represented", async () => {
    const stack = await setup([{ bucket: 130, payout: eth("3") }], {}, [
      prim(1),
      prim(2),
      prim(3),
      cand(1),
      cand(2),
    ]);
    const receipt = await playCurrentRound(stack, stack.eventId, HONEST);
    expect(findLogs(stack, receipt, "EscalationRequested")).to.have.length(0);
    expect((await stack.engine.eventState(stack.eventId)).status).to.equal(Status.DEFAULT_PENDING);
    expect(await stack.engine.held(stack.eventId)).to.equal(eth("3"));
  });

  it("settles a rainfall event using only weather sources", async () => {
    const stack = await deployEngine();
    const { registry, book, vault, engine } = stack;
    await vault.connect(stack.lp1).deposit({ value: eth("100") });
    // The helper registers two rain sources (ids 7 and 8); add a third, as the local stack does.
    const third = ethers.Wallet.createRandom();
    await registry.registerSource(third.address, RAIN_24H, "S9", [stack.toolHash]);
    const rainWallets = [stack.sourceWallets[6], stack.sourceWallets[7], third];
    const rainOracles = stack.rest.slice(8, 11);
    for (let i = 0; i < 3; i++) {
      await registry.registerOracle(rainOracles[i].address, RAIN_24H, 7 + i, true);
    }

    const now = await time.latest();
    await book.createEvent(
      RAIN_24H,
      "Chennai rain",
      "13.08,80.27|2026-10-12",
      now + 1000,
      now + 2000,
    );
    const eventId = await book.eventCount();
    await bindPolicy(stack, stack.alice, eventId, 80, eth("1"));
    await bindPolicy(stack, stack.alice, eventId, 150, eth("1"));
    await time.increaseTo(now + 2000);
    await engine.openRound(eventId);
    const committee = await engine.committeeOf(eventId, 1);
    expect([...committee]).to.deep.equal(rainOracles.map((o) => o.address));

    const st = await engine.eventState(eventId);
    const signed = [];
    for (let i = 0; i < 3; i++) {
      const r = await signReport(stack, rainWallets[i], eventId, milli(95 + i));
      await engine
        .connect(rainOracles[i])
        .commit(eventId, 1, commitHash(r, SALT, rainOracles[i].address));
      signed.push(r);
    }
    await time.increaseTo(Number(st.commitDeadline));
    for (let i = 0; i < 3; i++) {
      const r = signed[i];
      await engine
        .connect(rainOracles[i])
        .reveal(
          eventId,
          1,
          r.value,
          r.ts,
          r.toolHash,
          r.argsHash,
          r.responseHash,
          r.sourceSig,
          SALT,
        );
    }
    await time.increaseTo(Number(st.revealDeadline));
    await engine.finalizeRound(eventId);

    expect((await engine.eventState(eventId)).status).to.equal(Status.FINAL);
    expect(await vault.claimable()).to.equal(eth("1"));
    expect(await vault.locked()).to.equal(0n);
    await book.connect(stack.alice).claim(1);
    await expect(book.connect(stack.alice).claim(2)).to.be.revertedWithCustomError(
      book,
      "NotSettledPaying",
    );
    await conserved(stack);
  });

  it("lets a liquidity provider withdraw only free liquidity while collateral is held", async () => {
    const stack = await setup(
      [{ bucket: 130, payout: eth("3") }],
      NO_RECRUIT,
      undefined,
      eth("20"),
    );
    const { vault, engine, lp1, eventId } = stack;
    await playCurrentRound(stack, eventId, HONEST);
    let st = await engine.eventState(eventId);
    expect(st.status).to.equal(Status.DEFAULT_PENDING);
    expect(await vault.locked()).to.equal(eth("3"));

    const max = await vault.maxWithdraw(lp1.address);
    expect(max).to.equal(await vault.freeLiquidity());
    await expect(vault.connect(lp1).withdraw(max + 1n)).to.be.revertedWithCustomError(
      vault,
      "WithdrawExceedsMax",
    );
    await vault.connect(lp1).withdraw(max);
    expect(await vault.freeLiquidity()).to.equal(0n);
    expect(await vault.locked()).to.equal(eth("3"));
    await conserved(stack);

    // Once the held policy settles as not paying, the collateral is withdrawable again.
    await time.increaseTo(Number(st.challengeDeadline));
    await engine.applyDefault(eventId);
    st = await engine.eventState(eventId);
    expect(st.status).to.equal(Status.FINAL);
    expect(await vault.locked()).to.equal(0n);
    expect(await vault.maxWithdraw(lp1.address)).to.be.gt(eth("2.9"));
    await vault.connect(lp1).withdraw(await vault.maxWithdraw(lp1.address));
    await conserved(stack);
  });
});
