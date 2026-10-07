import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: { chainId: 31337, loggingEnabled: process.env.HARDHAT_LOGGING === "true" },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
  },
  gasReporter: { enabled: process.env.REPORT_GAS === "true" },
  paths: { sources: "./contracts", tests: "./test" },
};

export default config;
