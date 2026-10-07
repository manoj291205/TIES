/**
 * The fixed local topology: which upstream sources exist, which port each one listens on and
 * which Hardhat account plays which role. Source ids are the registry ids (registered in order).
 */
export const CATEGORY = { FLIGHT: 0, RAIN: 1 } as const;
export type CategoryName = keyof typeof CATEGORY;

export type ToolName = "get_flight_delay" | "get_rainfall_24h";

export interface SourceDef {
  /** Registry id (1-based). */
  id: number;
  /** Short key such as "S1". */
  key: string;
  name: string;
  category: number;
  port: number;
  kind: "mock" | "real";
  tool: ToolName;
  /** Default Gaussian noise of a mock source, in report units (minutes or mm). */
  sigma: number;
}

export const SOURCES: SourceDef[] = [
  {
    id: 1,
    key: "S1",
    name: "Airline status API",
    category: 0,
    port: 7101,
    kind: "mock",
    tool: "get_flight_delay",
    sigma: 2,
  },
  {
    id: 2,
    key: "S2",
    name: "Aggregator A",
    category: 0,
    port: 7102,
    kind: "mock",
    tool: "get_flight_delay",
    sigma: 3,
  },
  {
    id: 3,
    key: "S3",
    name: "Aggregator B",
    category: 0,
    port: 7103,
    kind: "mock",
    tool: "get_flight_delay",
    sigma: 3,
  },
  {
    id: 4,
    key: "S4",
    name: "ADS-B network",
    category: 0,
    port: 7104,
    kind: "mock",
    tool: "get_flight_delay",
    sigma: 4,
  },
  {
    id: 5,
    key: "S5",
    name: "Airport FIDS",
    category: 0,
    port: 7105,
    kind: "mock",
    tool: "get_flight_delay",
    sigma: 2.5,
  },
  {
    id: 6,
    key: "S6",
    name: "Ops feed",
    category: 0,
    port: 7106,
    kind: "mock",
    tool: "get_flight_delay",
    sigma: 3,
  },
  {
    id: 7,
    key: "S7",
    name: "Open-Meteo archive",
    category: 1,
    port: 7107,
    kind: "real",
    tool: "get_rainfall_24h",
    sigma: 0,
  },
  {
    id: 8,
    key: "S8",
    name: "Local weather station",
    category: 1,
    port: 7108,
    kind: "mock",
    tool: "get_rainfall_24h",
    sigma: 1,
  },
  {
    id: 9,
    key: "S9",
    name: "Satellite estimate",
    category: 1,
    port: 7109,
    kind: "mock",
    tool: "get_rainfall_24h",
    sigma: 1.5,
  },
];

export const sourceByKey = (key: string): SourceDef => {
  const found = SOURCES.find((s) => s.key === key || String(s.id) === key);
  if (!found) throw new Error(`unknown source ${key}`);
  return found;
};

/** Hardhat account indices by role (CLAUDE.md section 4). */
export const ACCOUNTS = {
  admin: 0,
  lps: [1, 2, 3],
  holders: [4, 5, 6, 7, 8],
  keeper: 9,
  oracles: [10, 11, 12, 13, 14, 15, 16, 17],
  challenger: 18,
  spare: 19,
} as const;

export const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

export const PORTS: { oracleNode: number; demoServer: number; rpc: number } = {
  oracleNode: 7200,
  demoServer: 7000,
  rpc: 8545,
};
