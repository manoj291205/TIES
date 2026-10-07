import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployCore,
  FLIGHT_DELAY,
  FLIGHT_DELAY_PARAMS,
  RAIN_24H,
  RAIN_24H_PARAMS,
  ONE,
} from "./helpers/deploy";

describe("TIESRegistry", () => {
  describe("categories", () => {
    it("stores the spec defaults and returns them unchanged", async () => {
      const { registry } = await deployCore();
      const p = await registry.getParams(FLIGHT_DELAY, 0);
      expect(p.unit).to.equal("min");
      expect(p.bucketCount).to.equal(721);
      expect(p.bucketWidth).to.equal(1000n);
      expect(p.s).to.equal(15_000n);
      expect(p.sigmaFloor).to.equal(3_000n);
      expect(p.nMin).to.equal(18n * 10n ** 17n);
      expect(p.kMax).to.equal(3);
      expect(p.kRound).to.equal(2);
      expect(p.zByRound.map(BigInt)).to.deep.equal(FLIGHT_DELAY_PARAMS.zByRound);
      expect(p.curveTheta.map(BigInt)).to.deep.equal(FLIGHT_DELAY_PARAMS.curveTheta);
      const r = await registry.getParams(RAIN_24H, 0);
      expect(r.bucketCount).to.equal(301);
      expect(r.curveProb.map(BigInt)).to.deep.equal(RAIN_24H_PARAMS.curveProb);
    });

    it("appends versions instead of overwriting", async () => {
      const { registry } = await deployCore();
      expect(await registry.versionCount(FLIGHT_DELAY)).to.equal(1n);
      await expect(
        registry.setCategory(FLIGHT_DELAY, { ...FLIGHT_DELAY_PARAMS, margin: ONE / 10n }),
      )
        .to.emit(registry, "CategoryUpdated")
        .withArgs(FLIGHT_DELAY, 1n);
      expect(await registry.versionCount(FLIGHT_DELAY)).to.equal(2n);
      expect(await registry.latestVersion(FLIGHT_DELAY)).to.equal(1n);
      expect((await registry.getParams(FLIGHT_DELAY, 0)).margin).to.equal(ONE / 5n);
      expect((await registry.getParams(FLIGHT_DELAY, 1)).margin).to.equal(ONE / 10n);
    });

    it("reports unknown categories and versions", async () => {
      const { registry } = await deployCore();
      await expect(registry.latestVersion(9)).to.be.revertedWithCustomError(
        registry,
        "UnknownCategory",
      );
      await expect(registry.getParams(FLIGHT_DELAY, 5)).to.be.revertedWithCustomError(
        registry,
        "UnknownCategory",
      );
    });

    it("rejects invalid parameter sets", async () => {
      const { registry } = await deployCore();
      const bad: Record<string, Partial<typeof FLIGHT_DELAY_PARAMS>> = {
        bucketCount: { bucketCount: 0 },
        bucketWidth: { bucketWidth: 0n },
        rounds: { kMax: 0 },
        maxReportsPerEvent: { maxReportsPerEvent: 17 },
        s: { s: 0n },
        delta: { delta: 0n },
        nMin: { nMin: ONE },
        rho0: { rho0: ONE + 1n },
        initialReputation: { alpha0: 0n },
        gamma: { gamma: 0n },
        mu: { mu: ONE + 1n },
        eta: { eta: 0n },
        zByRound: { zByRound: [1n] },
        zByRoundTooLong: { zByRound: Array.from({ length: 33 }, () => ONE) },
        curveLength: { curveProb: [ONE] },
        curveTooLong: {
          curveTheta: Array.from({ length: 33 }, (_, i) => BigInt(i)),
          curveProb: Array.from({ length: 33 }, () => ONE),
        },
        curveProb: { curveProb: FLIGHT_DELAY_PARAMS.curveProb.map(() => ONE + 1n) },
        curveTheta: { curveTheta: [...FLIGHT_DELAY_PARAMS.curveTheta].reverse() },
        curveIncreasing: {
          curveProb: FLIGHT_DELAY_PARAMS.curveProb.map((_, i) => BigInt(i + 1)),
        },
      };
      for (const [name, override] of Object.entries(bad)) {
        await expect(
          registry.setCategory(FLIGHT_DELAY, { ...FLIGHT_DELAY_PARAMS, ...override }),
          name,
        ).to.be.revertedWithCustomError(registry, "InvalidParams");
      }
    });

    it("lets only the admin change categories", async () => {
      const { registry, alice } = await deployCore();
      await expect(
        registry.connect(alice).setCategory(FLIGHT_DELAY, FLIGHT_DELAY_PARAMS),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("sources", () => {
    it("registers sources, counts active ones and keeps the tool allowlist", async () => {
      const { registry, sourceWallets, toolHash } = await deployCore();
      expect(await registry.sourceCount()).to.equal(8n);
      expect(await registry.activeSourceCount(FLIGHT_DELAY)).to.equal(6n);
      expect(await registry.activeSourceCount(RAIN_24H)).to.equal(2n);
      const [signer, category, active, name] = await registry.getSource(1);
      expect(signer).to.equal(sourceWallets[0].address);
      expect(category).to.equal(FLIGHT_DELAY);
      expect(active).to.equal(true);
      expect(name).to.equal("S1");
      expect(await registry.sourceIdOfSigner(sourceWallets[0].address)).to.equal(1n);
      expect(await registry.toolHashAllowed(1, toolHash)).to.equal(true);
    });

    it("toggles active state and tool hashes", async () => {
      const { registry, toolHash } = await deployCore();
      await expect(registry.setSourceActive(1, false)).to.emit(registry, "SourceUpdated");
      expect(await registry.activeSourceCount(FLIGHT_DELAY)).to.equal(5n);
      await registry.setSourceActive(1, false); // no double counting
      expect(await registry.activeSourceCount(FLIGHT_DELAY)).to.equal(5n);
      await registry.setSourceActive(1, true);
      expect(await registry.activeSourceCount(FLIGHT_DELAY)).to.equal(6n);
      await expect(registry.setToolHash(1, toolHash, false)).to.emit(registry, "ToolHashUpdated");
      expect(await registry.toolHashAllowed(1, toolHash)).to.equal(false);
    });

    it("rejects bad registrations and unknown sources", async () => {
      const { registry, sourceWallets } = await deployCore();
      const zero = ethers.ZeroAddress;
      await expect(registry.registerSource(zero, 0, "x", [])).to.be.revertedWithCustomError(
        registry,
        "ZeroAddress",
      );
      await expect(
        registry.registerSource(sourceWallets[0].address, 0, "dup", []),
      ).to.be.revertedWithCustomError(registry, "SourceAlreadyRegistered");
      await expect(
        registry.registerSource(ethers.Wallet.createRandom().address, 9, "x", []),
      ).to.be.revertedWithCustomError(registry, "UnknownCategory");
      await expect(registry.getSource(99)).to.be.revertedWithCustomError(registry, "UnknownSource");
      await expect(registry.setSourceActive(99, true)).to.be.revertedWithCustomError(
        registry,
        "UnknownSource",
      );
      await expect(registry.setToolHash(99, ethers.ZeroHash, true)).to.be.revertedWithCustomError(
        registry,
        "UnknownSource",
      );
    });

    it("restricts source management to the admin", async () => {
      const { registry, alice, toolHash } = await deployCore();
      const r = registry.connect(alice);
      const err = "AccessControlUnauthorizedAccount";
      await expect(r.registerSource(alice.address, 0, "x", [])).to.be.revertedWithCustomError(
        registry,
        err,
      );
      await expect(r.setSourceActive(1, false)).to.be.revertedWithCustomError(registry, err);
      await expect(r.setToolHash(1, toolHash, true)).to.be.revertedWithCustomError(registry, err);
    });
  });

  describe("oracles", () => {
    it("registers oracles with the initial reputation of the category", async () => {
      const { registry, alice, bob } = await deployCore();
      await expect(registry.registerOracle(alice.address, FLIGHT_DELAY, 1, true))
        .to.emit(registry, "OracleRegistered")
        .withArgs(alice.address, FLIGHT_DELAY, 1, true);
      await registry.registerOracle(bob.address, FLIGHT_DELAY, 2, false);
      const [alpha, beta] = await registry.reputation(alice.address, FLIGHT_DELAY);
      expect(alpha).to.equal(4n * ONE);
      expect(beta).to.equal(ONE);
      expect(await registry.reputationWeight(alice.address, FLIGHT_DELAY)).to.equal(
        (8n * ONE) / 10n,
      );
      expect(await registry.oracleCount(FLIGHT_DELAY)).to.equal(2n);
      expect(await registry.oracleAt(FLIGHT_DELAY, 1)).to.equal(bob.address);
      expect(await registry.isOracle(alice.address)).to.equal(true);
      const [registered, active, primary, sourceId] = await registry.getOracle(
        alice.address,
        FLIGHT_DELAY,
      );
      expect([registered, active, primary, sourceId]).to.deep.equal([true, true, true, 1n]);
    });

    it("returns zero reputation weight for unknown oracles", async () => {
      const { registry, alice } = await deployCore();
      expect(await registry.reputationWeight(alice.address, FLIGHT_DELAY)).to.equal(0n);
      expect(await registry.isOracle(alice.address)).to.equal(false);
    });

    it("updates an oracle and rejects invalid changes", async () => {
      const { registry, alice } = await deployCore();
      await registry.registerOracle(alice.address, FLIGHT_DELAY, 1, true);
      await expect(registry.updateOracle(alice.address, FLIGHT_DELAY, 2, false, false))
        .to.emit(registry, "OracleUpdated")
        .withArgs(alice.address, FLIGHT_DELAY, 2, false, false);
      const [, active, primary, sourceId] = await registry.getOracle(alice.address, FLIGHT_DELAY);
      expect([active, primary, sourceId]).to.deep.equal([false, false, 2n]);
      await expect(
        registry.updateOracle(alice.address, FLIGHT_DELAY, 7, true, true),
      ).to.be.revertedWithCustomError(registry, "SourceCategoryMismatch");
      await expect(
        registry.updateOracle(alice.address, FLIGHT_DELAY, 99, true, true),
      ).to.be.revertedWithCustomError(registry, "UnknownSource");
      await expect(
        registry.updateOracle(alice.address, RAIN_24H, 7, true, true),
      ).to.be.revertedWithCustomError(registry, "UnknownOracle");
    });

    it("rejects bad registrations", async () => {
      const { registry, alice } = await deployCore();
      await expect(
        registry.registerOracle(ethers.ZeroAddress, FLIGHT_DELAY, 1, true),
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(
        registry.registerOracle(alice.address, 9, 1, true),
      ).to.be.revertedWithCustomError(registry, "UnknownCategory");
      await expect(
        registry.registerOracle(alice.address, FLIGHT_DELAY, 7, true),
      ).to.be.revertedWithCustomError(registry, "SourceCategoryMismatch");
      await registry.registerOracle(alice.address, FLIGHT_DELAY, 1, true);
      await expect(
        registry.registerOracle(alice.address, FLIGHT_DELAY, 1, true),
      ).to.be.revertedWithCustomError(registry, "OracleAlreadyRegistered");
    });

    it("caps the oracle list per category", async () => {
      const { registry } = await deployCore();
      const max = Number(await registry.MAX_ORACLES_PER_CATEGORY());
      for (let i = 0; i < max; i++) {
        await registry.registerOracle(ethers.Wallet.createRandom().address, FLIGHT_DELAY, 1, false);
      }
      await expect(
        registry.registerOracle(ethers.Wallet.createRandom().address, FLIGHT_DELAY, 1, false),
      ).to.be.revertedWithCustomError(registry, "TooManyOracles");
    });

    it("lets only the engine change reputation", async () => {
      const { registry, alice, engineSigner } = await deployCore();
      await registry.registerOracle(alice.address, FLIGHT_DELAY, 1, true);
      await expect(
        registry.connect(alice).setReputation(alice.address, FLIGHT_DELAY, 1n, 1n),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(
        registry.connect(engineSigner).setReputation(alice.address, FLIGHT_DELAY, 5n * ONE, ONE),
      )
        .to.emit(registry, "ReputationUpdated")
        .withArgs(alice.address, FLIGHT_DELAY, 5n * ONE, ONE);
      expect((await registry.reputation(alice.address, FLIGHT_DELAY))[0]).to.equal(5n * ONE);
      await expect(
        registry.connect(engineSigner).setReputation(alice.address, RAIN_24H, 1n, 1n),
      ).to.be.revertedWithCustomError(registry, "UnknownOracle");
    });

    it("restricts oracle management to the admin", async () => {
      const { registry, alice } = await deployCore();
      const err = "AccessControlUnauthorizedAccount";
      await expect(
        registry.connect(alice).registerOracle(alice.address, FLIGHT_DELAY, 1, true),
      ).to.be.revertedWithCustomError(registry, err);
      await expect(
        registry.connect(alice).updateOracle(alice.address, FLIGHT_DELAY, 1, true, true),
      ).to.be.revertedWithCustomError(registry, err);
    });
  });

  describe("dependence", () => {
    it("returns 1 for identical sources, the fallback when unlearned, and the stored value", async () => {
      const { registry, engineSigner } = await deployCore();
      const prior = ONE / 5n;
      expect(await registry.dependence(1, 1, prior)).to.equal(ONE);
      expect(await registry.dependence(1, 2, prior)).to.equal(prior);
      await expect(registry.connect(engineSigner).setDependence(2, 1, ONE / 2n))
        .to.emit(registry, "DependenceUpdated")
        .withArgs(1, 2, ONE / 2n);
      expect(await registry.dependence(1, 2, prior)).to.equal(ONE / 2n);
      expect(await registry.dependence(2, 1, prior)).to.equal(ONE / 2n);
      await registry.connect(engineSigner).setDependence(1, 2, ONE);
      expect(await registry.dependence(2, 1, prior)).to.equal(ONE);
    });

    it("rejects invalid values and non-engine callers", async () => {
      const { registry, engineSigner, alice } = await deployCore();
      const e = registry.connect(engineSigner);
      await expect(e.setDependence(1, 1, ONE / 2n)).to.be.revertedWithCustomError(
        registry,
        "InvalidDependence",
      );
      await expect(e.setDependence(1, 2, 0)).to.be.revertedWithCustomError(
        registry,
        "InvalidDependence",
      );
      await expect(e.setDependence(1, 2, ONE + 1n)).to.be.revertedWithCustomError(
        registry,
        "InvalidDependence",
      );
      await expect(
        registry.connect(alice).setDependence(1, 2, ONE / 2n),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });
});
