import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  CategoryParams,
  FLIGHT_DELAY,
  FLIGHT_DELAY_PARAMS,
  RAIN_24H,
  RAIN_24H_PARAMS,
} from "../../packages/ties-math/src";

export { FLIGHT_DELAY, RAIN_24H, FLIGHT_DELAY_PARAMS, RAIN_24H_PARAMS };
export type { CategoryParams };

export const ONE = 10n ** 18n;
export const eth = (v: string) => ethers.parseEther(v);

/** Deploys vault, registry and policy book with roles wired and both categories configured. */
export async function deployCore(overrides: Partial<CategoryParams> = {}) {
  const signers = await ethers.getSigners();
  const [admin, lp1, lp2, alice, bob, engineSigner, ...rest] = signers;

  const vault = await (await ethers.getContractFactory("Vault")).deploy(admin.address);
  const registry = await (await ethers.getContractFactory("TIESRegistry")).deploy(admin.address);
  const book = await (
    await ethers.getContractFactory("PolicyBook")
  ).deploy(await vault.getAddress(), await registry.getAddress(), admin.address);
  const mockEngine = await (
    await ethers.getContractFactory("MockEngine")
  ).deploy(await vault.getAddress());

  await vault.grantRole(await vault.BOOK_ROLE(), await book.getAddress());
  await vault.grantRole(await vault.ENGINE_ROLE(), await mockEngine.getAddress());
  await registry.grantRole(await registry.ENGINE_ROLE(), engineSigner.address);
  await book.setEngine(await mockEngine.getAddress());

  const flight = { ...FLIGHT_DELAY_PARAMS, ...overrides };
  await registry.setCategory(FLIGHT_DELAY, flight);
  await registry.setCategory(RAIN_24H, RAIN_24H_PARAMS);

  // Six flight sources (distinct signer keys) and two rain sources.
  const sourceWallets = Array.from({ length: 8 }, () => ethers.Wallet.createRandom());
  const toolHash = ethers.id("get_flight_delay");
  for (let i = 0; i < 6; i++) {
    await registry.registerSource(sourceWallets[i].address, FLIGHT_DELAY, `S${i + 1}`, [toolHash]);
  }
  for (let i = 6; i < 8; i++) {
    await registry.registerSource(sourceWallets[i].address, RAIN_24H, `S${i + 1}`, [toolHash]);
  }

  return {
    admin,
    lp1,
    lp2,
    alice,
    bob,
    engineSigner,
    rest,
    vault,
    registry,
    book,
    mockEngine,
    sourceWallets,
    toolHash,
    flight,
  };
}

/** Creates a flight event whose cutoff is `cutoffIn` seconds from now. */
export async function createFlightEvent(
  book: Awaited<ReturnType<typeof deployCore>>["book"],
  cutoffIn = 1000,
  observationIn = 2000,
) {
  const now = await time.latest();
  const tx = await book.createEvent(
    FLIGHT_DELAY,
    "AI 101 DEL-BOM 2026-10-12",
    "AI101|2026-10-12",
    now + cutoffIn,
    now + observationIn,
  );
  await tx.wait();
  return await book.eventCount();
}

/** Deterministic pseudo-random generator for reproducible property tests. */
export function makeRng(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}
