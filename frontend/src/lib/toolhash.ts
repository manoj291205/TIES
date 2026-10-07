import { keccak256, toUtf8Bytes } from "ethers";

/** Same canonical form the source servers use, so the hash matches what they sign with. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, sort(val)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export const TOOL_SCHEMAS: Record<string, object> = {
  get_flight_delay: {
    type: "object",
    properties: {
      eventId: { type: "integer" },
      flight: { type: "string" },
      date: { type: "string" },
    },
    required: ["eventId", "flight", "date"],
  },
  get_rainfall_24h: {
    type: "object",
    properties: {
      eventId: { type: "integer" },
      lat: { type: "number" },
      lon: { type: "number" },
      date: { type: "string" },
    },
    required: ["eventId", "lat", "lon", "date"],
  },
};

/** keccak256 of the tool name followed by its canonical JSON input schema. */
export const toolHashOf = (tool: string): string =>
  keccak256(toUtf8Bytes(tool + canonicalJson(TOOL_SCHEMAS[tool])));
