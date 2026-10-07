import { expect } from "chai";
import { artifacts, network } from "hardhat";

const LIMIT = 24_576; // EIP-170 deployed bytecode limit, in bytes

describe("contract sizes", function () {
  // Coverage instrumentation inflates bytecode, so the real limit is only checked in normal runs.
  before(function () {
    if (network.config.allowUnlimitedContractSize) this.skip();
  });

  it("keeps every deployable contract under the 24 KB limit", async () => {
    const names = await artifacts.getAllFullyQualifiedNames();
    for (const fqn of names) {
      if (fqn.includes("/mocks/") || fqn.includes("@openzeppelin")) continue;
      const artifact = await artifacts.readArtifact(fqn);
      const bytes = (artifact.deployedBytecode.length - 2) / 2;
      expect(bytes, `${fqn} is ${bytes} bytes`).to.be.lte(LIMIT);
    }
  });
});
