import type { Logger } from "../../shared/src";

const ARCHIVE =
  process.env.OPEN_METEO_ARCHIVE_URL ?? "https://archive-api.open-meteo.com/v1/archive";
const FORECAST = process.env.OPEN_METEO_FORECAST_URL ?? "https://api.open-meteo.com/v1/forecast";

async function fetchDaily(
  base: string,
  lat: number,
  lon: number,
  date: string,
): Promise<number | null> {
  const url =
    `${base}?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}` +
    `&daily=precipitation_sum&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(base).host}`);
  const body = (await res.json()) as { daily?: { precipitation_sum?: (number | null)[] } };
  const value = body.daily?.precipitation_sum?.[0];
  return typeof value === "number" ? value : null;
}

/**
 * 24-hour rainfall in mm for a place and a day, from Open-Meteo (no API key). The archive covers
 * past dates; very recent dates fall back to the forecast endpoint.
 */
export async function rainfallMm(
  lat: number,
  lon: number,
  date: string,
  log: Logger,
): Promise<number> {
  let archiveError = "";
  try {
    const v = await fetchDaily(ARCHIVE, lat, lon, date);
    if (v !== null) return v;
    archiveError = "archive has no value for that day";
  } catch (err) {
    archiveError = err instanceof Error ? err.message : String(err);
  }
  log.warn(`open-meteo archive failed for ${lat},${lon} ${date}: ${archiveError}; trying forecast`);
  try {
    const v = await fetchDaily(FORECAST, lat, lon, date);
    if (v !== null) return v;
    throw new Error("forecast has no value for that day");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`open-meteo unavailable for ${lat},${lon} ${date}: ${msg}`);
    throw new Error(`Open-Meteo unavailable (${archiveError}; ${msg})`);
  }
}
