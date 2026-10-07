/**
 * Declarative scenarios. The demo server runs them live against the local stack (M4); the
 * experiment runner reuses the same definitions (M8). A scenario says what the world looks like
 * (ground truth, which sources misbehave, which oracle keys are on the round-1 committee, which
 * policies exist); the contracts, oracle nodes and keeper do the rest.
 */
export type NodeMode = "honest" | "tamper" | "silent" | "late";

export interface SourceBehaviour {
  mode?: "honest" | "offset";
  /** Added to the true value (minutes or mm) when mode is "offset". */
  offset?: number;
  /** Gaussian noise sigma in report units. */
  sigma?: number;
  delayMs?: number;
  down?: boolean;
}

export interface PolicySpec {
  /** Hardhat account index of the policyholder (#4 to #8). */
  holder: number;
  /** Threshold bucket (1 unit per bucket). */
  bucket: number;
  /** Payout in ETH. */
  payout: string;
}

export interface Expectation {
  /** Status the event must end in once the scenario (including any resolve step) is over. */
  finalStatus?: "FINAL" | "DISPUTED";
  /** Highest acceptable number of wrongly settled policies versus the ground truth. */
  maxWrongSettlements?: number;
  /** Outcome of the first round. */
  firstRound?: "INSUFFICIENT" | "VALID" | "DISPUTED";
  /** Minimum number of reveal transactions that must revert. */
  minRevertedReveals?: number;
  /** Event must pass through more than one round. */
  escalated?: boolean;
}

export interface ScenarioDef {
  name: string;
  title: string;
  description: string;
  category: "FLIGHT" | "RAIN";
  /** Ground truth in report units, or "real" to use what Open-Meteo reports. */
  truth: number | "real";
  /** Oracle nodes on the round-1 committee (ids from services/oracle-node/nodes.json). */
  committee: string[];
  policies: PolicySpec[];
  sources?: Record<string, SourceBehaviour>;
  nodes?: Record<string, NodeMode>;
  /** A challenger disputes the pending default (posting the bond). */
  challenge?: boolean;
  /** The admin resolves a dispute at the true value (ends the scenario in FINAL). */
  resolveDispute?: boolean;
  expect: Expectation;
}

const FLIGHT_COMMITTEE = ["n1", "n2", "n3"];
const TWO_KEYS_ONE_FEED = ["n1", "n2", "n7"];

/** Policies spread so that most thresholds are far from the truth of 130 minutes. */
const SPREAD: PolicySpec[] = [
  { holder: 4, bucket: 60, payout: "1" },
  { holder: 5, bucket: 100, payout: "1.5" },
  { holder: 6, bucket: 170, payout: "1" },
  { holder: 7, bucket: 200, payout: "1" },
];

/** Policies packed around the truth, so a lot of collateral sits inside the evidence interval. */
const CLUSTER: PolicySpec[] = [
  { holder: 4, bucket: 60, payout: "1" },
  { holder: 5, bucket: 120, payout: "1.5" },
  { holder: 6, bucket: 126, payout: "1.5" },
  { holder: 7, bucket: 134, payout: "1.5" },
  { holder: 8, bucket: 200, payout: "1" },
];

export const SCENARIOS: ScenarioDef[] = [
  {
    name: "honest",
    title: "Honest sources",
    description:
      "Three independent sources report the truth with small noise. Policies far from the truth settle in round 1 and nothing is left held.",
    category: "FLIGHT",
    truth: 130,
    committee: FLIGHT_COMMITTEE,
    policies: SPREAD,
    expect: { finalStatus: "FINAL", maxWrongSettlements: 0, firstRound: "VALID" },
  },
  {
    name: "compromised-feed",
    title: "Compromised feed",
    description:
      "Aggregator A is compromised (+90 min) and read by two oracle keys. Two keys on one feed count as one source, so round 1 cannot move money; recruited independent sources outvote the feed.",
    category: "FLIGHT",
    truth: 130,
    committee: TWO_KEYS_ONE_FEED,
    policies: CLUSTER,
    sources: { S2: { mode: "offset", offset: 90 } },
    expect: {
      finalStatus: "FINAL",
      maxWrongSettlements: 0,
      firstRound: "INSUFFICIENT",
      escalated: true,
    },
  },
  {
    name: "two-keys-one-feed",
    title: "Two keys, one feed",
    description:
      "Everyone is honest, but two of the three oracle keys read the same source. N_eff stays below the minimum, no collateral moves, and the contract recruits an unrepresented source.",
    category: "FLIGHT",
    truth: 130,
    committee: TWO_KEYS_ONE_FEED,
    policies: CLUSTER,
    expect: {
      finalStatus: "FINAL",
      maxWrongSettlements: 0,
      firstRound: "INSUFFICIENT",
      escalated: true,
    },
  },
  {
    name: "noisy-source",
    title: "Noisy source",
    description:
      "One source is very noisy (sigma 25 min). Its weight collapses and the others decide.",
    category: "FLIGHT",
    truth: 130,
    committee: ["n1", "n3", "n4"],
    policies: SPREAD,
    sources: { S4: { sigma: 25 } },
    expect: { finalStatus: "FINAL", maxWrongSettlements: 0 },
  },
  {
    name: "late-source",
    title: "Late source",
    description:
      "One oracle commits but tries to reveal after the window closes. Its reveal reverts and the committee's remaining evidence is used.",
    category: "FLIGHT",
    truth: 130,
    committee: FLIGHT_COMMITTEE,
    policies: CLUSTER,
    nodes: { n3: "late" },
    expect: { finalStatus: "FINAL", maxWrongSettlements: 0, minRevertedReveals: 1 },
  },
  {
    name: "silent-source",
    title: "Silent source",
    description:
      "One oracle commits and never reveals. It gets zero weight and a reputation penalty.",
    category: "FLIGHT",
    truth: 130,
    committee: FLIGHT_COMMITTEE,
    policies: CLUSTER,
    nodes: { n3: "silent" },
    expect: { finalStatus: "FINAL", maxWrongSettlements: 0 },
  },
  {
    name: "unavailable-source",
    title: "Unavailable source",
    description: "One source is down, so its oracle cannot fetch a report and never commits.",
    category: "FLIGHT",
    truth: 130,
    committee: FLIGHT_COMMITTEE,
    policies: CLUSTER,
    sources: { S3: { down: true } },
    expect: { finalStatus: "FINAL", maxWrongSettlements: 0 },
  },
  {
    name: "borderline",
    title: "Borderline value",
    description:
      "Policies sit one minute either side of the truth. The interval cannot separate them, escalation is judged futile and the rest goes to default, which can settle a borderline policy the wrong way.",
    category: "FLIGHT",
    truth: 130,
    committee: FLIGHT_COMMITTEE,
    policies: [
      { holder: 4, bucket: 60, payout: "1" },
      { holder: 5, bucket: 129, payout: "1.5" },
      { holder: 6, bucket: 130, payout: "1.5" },
      { holder: 7, bucket: 131, payout: "1.5" },
      { holder: 8, bucket: 200, payout: "1" },
    ],
    expect: { finalStatus: "FINAL" },
  },
  {
    name: "forged-report",
    title: "Forged report",
    description:
      "One oracle changes the value after the source signed it. The reveal fails signature verification and reverts; the forged value never counts.",
    category: "FLIGHT",
    truth: 130,
    committee: FLIGHT_COMMITTEE,
    policies: CLUSTER,
    nodes: { n2: "tamper" },
    expect: { finalStatus: "FINAL", maxWrongSettlements: 0, minRevertedReveals: 1 },
  },
  {
    name: "inconsistent-rounds",
    title: "Inconsistent rounds",
    description:
      "The sources recruited in round 2 disagree with round 1 by 45 min. Their reports are discounted by the agreement kernel, the interval widens, and the running intersection keeps everything already settled where it is.",
    category: "FLIGHT",
    truth: 130,
    committee: FLIGHT_COMMITTEE,
    policies: CLUSTER,
    sources: {
      S4: { mode: "offset", offset: 45 },
      S5: { mode: "offset", offset: 45 },
      S6: { mode: "offset", offset: 45 },
    },
    resolveDispute: true,
    expect: { finalStatus: "FINAL", maxWrongSettlements: 0, escalated: true },
  },
  {
    name: "challenged-default",
    title: "Challenged default",
    description:
      "Evidence is too tight to separate the policies around the truth, so the event reaches a pending default. A challenger posts the bond, the event is disputed, and the admin resolves it at the true value.",
    category: "FLIGHT",
    truth: 130,
    committee: FLIGHT_COMMITTEE,
    policies: CLUSTER,
    challenge: true,
    resolveDispute: true,
    expect: { finalStatus: "FINAL", maxWrongSettlements: 0 },
  },
  {
    name: "real-weather",
    title: "Real weather (Chennai)",
    description:
      "24-hour rainfall at Chennai on a real past date. Open-Meteo is the real source; two mock stations replay it with noise. Needs internet access.",
    category: "RAIN",
    truth: "real",
    committee: ["n8", "n9", "n10"],
    policies: [
      { holder: 4, bucket: 5, payout: "1" },
      { holder: 5, bucket: 20, payout: "1" },
      { holder: 6, bucket: 50, payout: "1" },
      { holder: 7, bucket: 100, payout: "1" },
    ],
    expect: { finalStatus: "FINAL" },
  },
];

export const scenarioByName = (name: string): ScenarioDef => {
  const found = SCENARIOS.find((s) => s.name === name);
  if (!found) {
    throw new Error(
      `unknown scenario "${name}"; choose one of ${SCENARIOS.map((s) => s.name).join(", ")}`,
    );
  }
  return found;
};
