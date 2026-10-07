import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployEngine, milli, signReport } from "./helpers/engine";
import { FLIGHT_DELAY, RAIN_24H } from "./helpers/deploy";

describe("SignedAdapterVerifier", () => {
  async function setup() {
    const stack = await deployEngine();
    // The verifier binds signatures to msg.sender, so a plain signer plays the engine here.
    const caller = stack.alice;
    const sign = (
      wallet = stack.sourceWallets[0],
      value = milli(130),
      opts: Parameters<typeof signReport>[4] = {},
    ) => signReport(stack, wallet, 1, value, { engineAddress: caller.address, ...opts });
    const observationEnd = BigInt(await time.latest()) + 100n;
    const verify = (r: Awaited<ReturnType<typeof sign>>, category = FLIGHT_DELAY) =>
      stack.verifier.connect(caller).verify(1, category, observationEnd, r);
    return { ...stack, caller, sign, verify, observationEnd };
  }

  it("returns the source id derived from the signature", async () => {
    const { sign, verify } = await setup();
    expect(await verify(await sign())).to.equal(1n);
    const { sign: sign2, verify: verify2 } = await setup();
    expect(await verify2(await sign2(undefined, milli(5)))).to.equal(1n);
  });

  it("identifies different sources by their keys, not by anything the caller says", async () => {
    const { sign, verify, sourceWallets } = await setup();
    expect(await verify(await sign(sourceWallets[3]))).to.equal(4n);
  });

  it("rejects a value changed after signing (forged report)", async () => {
    const { sign, verify, verifier } = await setup();
    const r = await sign();
    await expect(verify({ ...r, value: r.value + 1n })).to.be.revertedWithCustomError(
      verifier,
      "UnknownSigner",
    );
  });

  it("rejects an unregistered signer", async () => {
    const { sign, verify, verifier } = await setup();
    await expect(verify(await sign(ethers.Wallet.createRandom()))).to.be.revertedWithCustomError(
      verifier,
      "UnknownSigner",
    );
  });

  it("rejects malformed signatures", async () => {
    const { sign, verify, verifier } = await setup();
    const r = await sign();
    await expect(verify({ ...r, sourceSig: "0x1234" })).to.be.revertedWithCustomError(
      verifier,
      "InvalidSignature",
    );
  });

  it("rejects a report replayed for another event, engine or chain", async () => {
    const { sign, verify, verifier, caller, sourceWallets, toolHash, engineAddress } =
      await setup();
    const other = await signReport({ engineAddress, toolHash }, sourceWallets[0], 2, milli(130), {
      engineAddress: caller.address,
    });
    await expect(verify(other)).to.be.revertedWithCustomError(verifier, "UnknownSigner");
    const otherEngine = await sign(undefined, milli(130), { engineAddress: engineAddress });
    await expect(verify(otherEngine)).to.be.revertedWithCustomError(verifier, "UnknownSigner");
    const otherChain = await sign(undefined, milli(130), { chainId: 1n });
    await expect(verify(otherChain)).to.be.revertedWithCustomError(verifier, "UnknownSigner");
  });

  it("rejects sources of the wrong category", async () => {
    const { sign, verify, verifier, sourceWallets } = await setup();
    await expect(verify(await sign(sourceWallets[6]))).to.be.revertedWithCustomError(
      verifier,
      "SourceWrongCategory",
    );
    expect(await verify(await sign(sourceWallets[6]), RAIN_24H)).to.equal(7n);
  });

  it("rejects inactive sources and tool hashes that are not allowed", async () => {
    const { sign, verify, verifier, registry } = await setup();
    await expect(
      verify(await sign(undefined, milli(1), { toolHash: ethers.id("other") })),
    ).to.be.revertedWithCustomError(verifier, "ToolNotAllowed");
    await registry.setSourceActive(1, false);
    await expect(verify(await sign())).to.be.revertedWithCustomError(verifier, "SourceInactive");
  });

  it("enforces the timestamp window", async () => {
    const { sign, verify, verifier, observationEnd } = await setup();
    const now = BigInt(await time.latest());
    await expect(
      verify(await sign(undefined, milli(1), { ts: now + 1000n })),
    ).to.be.revertedWithCustomError(verifier, "FutureReport");
    const tooOld = observationEnd - (await verifier.MAX_REPORT_AGE()) - 1n;
    await expect(
      verify(await sign(undefined, milli(1), { ts: tooOld })),
    ).to.be.revertedWithCustomError(verifier, "StaleReport");
    const edge = observationEnd - (await verifier.MAX_REPORT_AGE());
    expect(await verify(await sign(undefined, milli(1), { ts: edge }))).to.equal(1n);
  });

  it("accepts any timestamp when the observation end is within one age window of zero", async () => {
    const { sign, verifier, caller } = await setup();
    const r = await sign(undefined, milli(1), { ts: 1n });
    expect(await verifier.connect(caller).verify(1, FLIGHT_DELAY, 100, r)).to.equal(1n);
  });
});
