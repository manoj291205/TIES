import { Interface, formatEther } from "ethers";

type Args = readonly unknown[];

const eth = (v: unknown) => `${Number(formatEther(BigInt(v as bigint))).toFixed(4)} ETH`;

/** Plain-language message per custom error. Arguments follow the Solidity declaration order. */
const MESSAGES: Record<string, (a: Args) => string> = {
  CapacityWindowExceeded: (a) =>
    `Too much cover near threshold ${a[0]}: ${eth(a[1])} is already bound there and the limit is ${eth(a[2])}. Try a threshold further away.`,
  EventShareExceeded: (a) =>
    `This event would lock ${eth(a[0])}, above the ${eth(a[1])} the vault allows for one event. Try a smaller payout.`,
  InsufficientVaultLiquidity: (a) =>
    `The vault has only ${eth(a[1])} free, not enough to back a ${eth(a[0])} payout.`,
  InsufficientPremium: (a) => `The premium is ${eth(a[1])}; you sent ${eth(a[0])}.`,
  CutoffPassed: () => "Binding for this event has closed.",
  BucketOutOfRange: (a) =>
    `Threshold ${a[0]} is outside the allowed range (0 to ${Number(a[1]) - 1}).`,
  ZeroPayout: () => "The payout must be greater than zero.",
  ZeroAmount: () => "The amount must be greater than zero.",
  ZeroShares: () => "That amount is too small to mint any vault shares.",
  DepositTooSmall: (a) => `The minimum deposit is ${eth(a[1])}.`,
  WithdrawExceedsMax: (a) =>
    `You asked for ${eth(a[0])} but can withdraw at most ${eth(a[1])} now. Locked and claimable funds cannot be withdrawn.`,
  InsufficientFree: (a) => `Only ${eth(a[1])} is free in the vault, not ${eth(a[0])}.`,
  AlreadyClaimed: () => "This policy has already been claimed.",
  NotSettledPaying: () =>
    "This policy has not been settled as paying (yet), so there is nothing to claim.",
  UnknownPolicy: (a) => `Policy ${a[0]} does not exist.`,
  UnknownEvent: (a) => `Event ${a[0]} does not exist.`,
  WrongStatus: (a) => `This action is not available in the event's current state (event ${a[0]}).`,
  WrongRound: (a) => `That round is closed; the event is in round ${a[0]}.`,
  ObservationNotEnded: () =>
    "The observation window has not ended yet, so evidence rounds cannot open.",
  NoCommittee: () => "No active oracle is flagged for this category, so no round can open.",
  NotInCommittee: () => "This account is not on the committee for this round.",
  CommitWindowClosed: () => "The commit window has closed.",
  CommitWindowOpen: () => "The commit window is still open; reveals start when it closes.",
  RevealWindowClosed: () => "The reveal window has closed.",
  RevealWindowOpen: () =>
    "The reveal window is still open; the round can be finalized when it closes.",
  AlreadyCommitted: () => "This oracle already committed in this round.",
  EmptyCommit: () => "The commit hash cannot be empty.",
  NoCommit: () => "No commit was found for this oracle in this round.",
  CommitMismatch: () =>
    "The revealed report does not match the commit (value, salt or signature differ).",
  AlreadyReported: () => "This oracle already reported for this event.",
  TooManyReports: (a) => `The event already has the maximum of ${a[0]} reports.`,
  InvalidSignature: () => "The source signature could not be read.",
  UnknownSigner: () => "The report was not signed by a registered source, so it was rejected.",
  SourceInactive: () => "The source that signed this report is switched off.",
  SourceWrongCategory: () => "The source that signed this report serves a different category.",
  ToolNotAllowed: () => "The source tool used for this report is not on the allowlist.",
  StaleReport: () => "The report is too old to be used.",
  FutureReport: () => "The report is timestamped in the future.",
  ChallengeWindowOpen: () =>
    "The challenge period is still running; the default can be applied when it ends.",
  ChallengeWindowClosed: () => "The challenge period has ended.",
  WrongBond: (a) => `Challenging needs a bond of exactly ${eth(a[1])}; you sent ${eth(a[0])}.`,
  InsufficientGasForLearning: () =>
    "Not enough gas was supplied to finish the event. Retry with a higher gas limit.",
  CursorRegression: () => "The settlement cursors would move backwards, which is not allowed.",
  NothingOwed: () => "There is no returned bond waiting for this account.",
  BondTransferFailed: () => "The bond could not be sent: the receiving account rejected the ETH.",
  InvalidParams: (a) => `Invalid parameter: ${a[0]}.`,
  InvalidCurve: () => "The exceedance curve is invalid.",
  InvalidDependence: () => "The dependence value is invalid.",
  InvalidEventTimes: () =>
    "The cutoff must be in the future and the observation end must not precede it.",
  UnknownCategory: (a) => `Category ${a[0]} is not configured.`,
  OracleAlreadyRegistered: () => "This oracle is already registered for the category.",
  SourceAlreadyRegistered: () => "A source with this signer is already registered.",
  UnknownOracle: () => "This account is not a registered oracle for the category.",
  UnknownSource: (a) => `Source ${a[0]} does not exist.`,
  ZeroAddress: () => "The address cannot be zero.",
  NotEngine: () => "Only the settlement engine can do this.",
  RefundFailed: () => "Refunding the excess payment failed.",
  TransferFailed: () => "The transfer failed.",
  AccessControlUnauthorizedAccount: () =>
    "This account does not have the role needed for this action.",
  ReentrancyGuardReentrantCall: () => "The contract refused a re-entrant call.",
};

export interface DecodedError {
  /** Plain-language explanation. */
  message: string;
  /** Raw custom error, e.g. `CapacityWindowExceeded(120,4.5e18,5e18)`. */
  raw: string;
  name: string | null;
  /** The user declined the signature in MetaMask. */
  rejected: boolean;
}

function revertDataOf(err: unknown, depth = 0): string[] {
  if (!err || typeof err !== "object" || depth > 4) return [];
  const e = err as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["data", "error", "info", "cause", "revert"]) {
    const v = e[key];
    if (typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v)) out.push(v);
    else if (v && typeof v === "object") out.push(...revertDataOf(v, depth + 1));
  }
  const text = typeof e.message === "string" ? e.message : "";
  out.push(...(text.match(/0x[0-9a-fA-F]{8,}/g) ?? []));
  return out;
}

/** Turns any thrown wallet or provider error into a message a person can act on. */
export function decodeError(err: unknown, interfaces: Interface[]): DecodedError {
  const e = err as { code?: unknown; shortMessage?: string; message?: string; reason?: string };
  const rejected = e?.code === "ACTION_REJECTED" || e?.code === 4001;
  if (rejected) {
    return {
      message: "You declined the request in MetaMask. Nothing was sent.",
      raw: "ACTION_REJECTED",
      name: null,
      rejected: true,
    };
  }
  for (const data of revertDataOf(err)) {
    for (const iface of interfaces) {
      let parsed;
      try {
        parsed = iface.parseError(data);
      } catch {
        parsed = null;
      }
      if (!parsed) continue;
      const args = Array.from(parsed.args) as unknown[];
      const render = MESSAGES[parsed.name];
      return {
        message: render ? render(args) : `The contract rejected the call (${parsed.name}).`,
        raw: `${parsed.name}(${args.map(String).join(",")})`,
        name: parsed.name,
        rejected: false,
      };
    }
  }
  const fallback = e?.reason ?? e?.shortMessage ?? e?.message ?? "The transaction failed.";
  return {
    message: fallback.split("\n")[0].slice(0, 240),
    raw: "unknown error",
    name: null,
    rejected: false,
  };
}
