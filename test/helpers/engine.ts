import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HDNodeWallet } from "ethers";
import { CategoryParams, deployCore, FLIGHT_DELAY } from "./deploy";

type Core = Awaited<ReturnType<typeof deployCore>>;
type Signer = Core["admin"];

export interface SignedReport {
  value: bigint;
  ts: bigint;
  toolHash: string;
  argsHash: string;
  responseHash: string;
  sourceSig: string;
}

/** Milli-units from a plain number of minutes or millimetres. */
export const milli = (units: number | bigint): bigint => BigInt(units) * 1000n;

/**
 * Deploys the whole stack (vault, registry, policy book, verifier, engine) with eight oracle keys:
 * oracle i is registered on flight source i+1 for i < 6, and oracles 6 and 7 share source 2
 * (the "two keys, one feed" case). All eight sit on the round-1 committee.
 */
export async function deployEngine(
  overrides: Partial<CategoryParams> = {},
  engineName: "SettlementEngine" | "SettlementEngineHarness" = "SettlementEngineHarness",
) {
  const core = await deployCore(overrides);
  const { admin, vault, registry, book, rest } = core;

  const verifier = await (
    await ethers.getContractFactory("SignedAdapterVerifier")
  ).deploy(await registry.getAddress());
  const engine = await (
    await ethers.getContractFactory(engineName)
  ).deploy(
    await vault.getAddress(),
    await book.getAddress(),
    await registry.getAddress(),
    await verifier.getAddress(),
    admin.address,
  );
  const engineAddress = await engine.getAddress();
  await vault.grantRole(await vault.ENGINE_ROLE(), engineAddress);
  await registry.grantRole(await registry.ENGINE_ROLE(), engineAddress);
  await book.setEngine(engineAddress);

  const oracles = rest.slice(0, 8);
  const oracleSource = [1, 2, 3, 4, 5, 6, 2, 2];
  for (let i = 0; i < oracles.length; i++) {
    await registry.registerOracle(oracles[i].address, FLIGHT_DELAY, oracleSource[i], true);
  }

  return { ...core, verifier, engine, engineAddress, oracles, oracleSource };
}

export type Stack = Awaited<ReturnType<typeof deployEngine>>;

/** Signs a report as a source adapter would (EIP-191 over the spec digest). */
export async function signReport(
  stack: Pick<Stack, "engineAddress" | "toolHash">,
  wallet: HDNodeWallet,
  eventId: bigint | number,
  value: bigint,
  opts: { ts?: bigint; toolHash?: string; engineAddress?: string; chainId?: bigint } = {},
): Promise<SignedReport> {
  const ts = opts.ts ?? BigInt(await time.latest());
  const toolHash = opts.toolHash ?? stack.toolHash;
  const argsHash = ethers.id(`args:${eventId}`);
  const responseHash = ethers.id(`response:${value}:${ts}`);
  const chainId = opts.chainId ?? (await ethers.provider.getNetwork()).chainId;
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256", "uint256", "uint256", "bytes32", "bytes32", "bytes32"],
      [
        chainId,
        opts.engineAddress ?? stack.engineAddress,
        eventId,
        value,
        ts,
        toolHash,
        argsHash,
        responseHash,
      ],
    ),
  );
  const sourceSig = await wallet.signMessage(ethers.getBytes(digest));
  return { value, ts, toolHash, argsHash, responseHash, sourceSig };
}

export function commitHash(r: SignedReport, salt: string, oracle: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "bytes32", "bytes32", "bytes32", "bytes", "bytes32", "address"],
      [r.value, r.ts, r.toolHash, r.argsHash, r.responseHash, r.sourceSig, salt, oracle],
    ),
  );
}

export const SALT = ethers.id("salt");

export interface RoundReport {
  oracle: number; // index into stack.oracles
  source: number; // index into stack.sourceWallets (the key that signs)
  value: bigint; // milli-units
}

/**
 * Plays one full round: everyone commits, the commit window passes, everyone reveals, the reveal
 * window passes and the round is finalized. Returns the finalize transaction.
 */
export async function playRound(stack: Stack, eventId: bigint | number, reports: RoundReport[]) {
  const { engine, oracles, sourceWallets } = stack;
  const st = await engine.eventState(eventId);
  const round = Number(st.round);
  const signed: { r: SignedReport; oracle: Signer }[] = [];
  for (const rep of reports) {
    const r = await signReport(stack, sourceWallets[rep.source], eventId, rep.value);
    const oracle = oracles[rep.oracle];
    await engine.connect(oracle).commit(eventId, round, commitHash(r, SALT, oracle.address));
    signed.push({ r, oracle });
  }
  await time.increaseTo(Number(st.commitDeadline));
  for (const { r, oracle } of signed) {
    await engine
      .connect(oracle)
      .reveal(
        eventId,
        round,
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
  return engine.finalizeRound(eventId);
}

/** Moves time to the observation end of an event and opens round 1. */
export async function openFirstRound(stack: Stack, eventId: bigint | number) {
  const meta = await stack.book.eventMeta(eventId);
  if ((await time.latest()) < Number(meta.observationEnd)) {
    await time.increaseTo(Number(meta.observationEnd));
  }
  await stack.engine.openRound(eventId);
}

/** Binds a policy from `holder` at `bucket`, paying exactly the quoted premium. */
export async function bindPolicy(
  stack: Pick<Stack, "book">,
  holder: Signer,
  eventId: bigint | number,
  bucket: number,
  payout: bigint,
) {
  const premium = await stack.book.quote(eventId, bucket, payout);
  return stack.book.connect(holder).bind(eventId, bucket, payout, { value: premium });
}

export function parseLog(
  stack: Pick<Stack, "engine">,
  receipt: { logs: readonly { topics: readonly string[]; data: string }[] } | null,
  name: string,
) {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = stack.engine.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === name) return parsed;
    } catch {
      // not an engine event
    }
  }
  throw new Error(`event ${name} not found`);
}
