import { useEffect, useMemo, useState } from "react";
import type { Contract } from "ethers";
import type { StatusKey } from "../components";
import { fmtDuration, weiToEth } from "../lib/format";
import { useChainClock, useContracts, useNetwork } from "./chain";
import { STATUS_NAMES, useContractEvents } from "./data";

/** Category parameters as stored in the registry (bigint fields as on chain). */
export interface Params {
  unit: string;
  bucketCount: number;
  maxReportsPerEvent: number;
  kMax: number;
  kRound: number;
  commitWindow: number;
  revealWindow: number;
  challengePeriod: number;
  bucketWidth: bigint;
  s: bigint;
  sigmaFloor: bigint;
  delta: bigint;
  dCut: bigint;
  nMin: bigint;
  rho0: bigint;
  uMin: bigint;
  rMin: bigint;
  alpha0: bigint;
  beta0: bigint;
  gamma: bigint;
  mu: bigint;
  eps: bigint;
  capacityCapPerWindow: bigint;
  eta: bigint;
  margin: bigint;
  escalationFee: bigint;
  zByRound: bigint[];
  curveTheta: bigint[];
  curveProb: bigint[];
}

const paramCache = new Map<string, Params>();

export async function fetchParams(
  registry: Contract,
  category: number,
  version: number,
): Promise<Params> {
  const key = `${await registry.getAddress()}:${category}:${version}`;
  const hit = paramCache.get(key);
  if (hit) return hit;
  const raw = await registry.getParams(category, version);
  const p: Params = {
    unit: raw.unit,
    bucketCount: Number(raw.bucketCount),
    maxReportsPerEvent: Number(raw.maxReportsPerEvent),
    kMax: Number(raw.kMax),
    kRound: Number(raw.kRound),
    commitWindow: Number(raw.commitWindow),
    revealWindow: Number(raw.revealWindow),
    challengePeriod: Number(raw.challengePeriod),
    bucketWidth: raw.bucketWidth,
    s: raw.s,
    sigmaFloor: raw.sigmaFloor,
    delta: raw.delta,
    dCut: raw.dCut,
    nMin: raw.nMin,
    rho0: raw.rho0,
    uMin: raw.uMin,
    rMin: raw.rMin,
    alpha0: raw.alpha0,
    beta0: raw.beta0,
    gamma: raw.gamma,
    mu: raw.mu,
    eps: raw.eps,
    capacityCapPerWindow: raw.capacityCapPerWindow,
    eta: raw.eta,
    margin: raw.margin,
    escalationFee: raw.escalationFee,
    zByRound: [...raw.zByRound],
    curveTheta: [...raw.curveTheta],
    curveProb: [...raw.curveProb],
  };
  paramCache.set(key, p);
  return p;
}

/** Parameters of the version an event snapshotted at creation. */
export function useEventParams(category: number | undefined, version: number | undefined) {
  const { read } = useContracts();
  const [params, setParams] = useState<Params | null>(null);
  useEffect(() => {
    if (!read || category == null || version == null) return setParams(null);
    let alive = true;
    fetchParams(read.registry, category, version)
      .then((p) => alive && setParams(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [read, category, version]);
  return params;
}

/** The fixed status vocabulary for an event, from the engine status and the chain clock. */
export function eventStatus(
  engineStatus: number,
  round: number,
  now: number,
  cutoff: number,
  observationEnd: number,
): { status: StatusKey; label?: string } {
  switch (STATUS_NAMES[engineStatus]) {
    case "NONE":
      if (now < cutoff) return { status: "open" };
      if (now < observationEnd) return { status: "cutoff" };
      return { status: "awaiting" };
    case "ROUND_COMMIT":
    case "ROUND_REVEAL":
      return { status: "settling", label: `Settling – Round ${round}` };
    case "DEFAULT_PENDING":
      return { status: "settling", label: "Default pending" };
    case "DISPUTED":
      return { status: "disputed" };
    default:
      return { status: "settled" };
  }
}

export interface EventRow {
  id: number;
  label: string;
  key: string;
  category: number;
  version: number;
  kind: "flight" | "weather";
  unit: "min" | "mm";
  cutoff: number;
  observationEnd: number;
  locked: bigint;
  engineStatus: number;
  round: number;
  status: StatusKey;
  statusLabel?: string;
  policies: number;
  /** Largest cover the vault allows on one event (eta x total assets), in ETH. */
  capacity: number;
  capacityLeft: number;
  cutoffText: string;
  windowText: string;
}

/** All events with their live state; re-read on every new block. */
export function useEventList() {
  const { read } = useContracts();
  const { block } = useNetwork();
  const now = useChainClock();
  const bound = useContractEvents(["PolicyBound"]);
  const [raw, setRaw] = useState<
    Omit<EventRow, "status" | "statusLabel" | "cutoffText" | "policies">[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!read) {
      setRaw([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const count = Number(await read.book.eventCount());
        const totalAssets = (await read.vault.totalAssets()) as bigint;
        const rows = [];
        for (let id = 1; id <= count; id++) {
          const [d, st] = await Promise.all([read.book.eventData(id), read.engine.eventState(id)]);
          const p = await fetchParams(read.registry, Number(d.category), Number(d.version));
          const capacity = weiToEth((totalAssets * p.eta) / 10n ** 18n);
          const lockedEth = weiToEth(d.locked);
          const date = String(d.observationKey).split("|")[1] ?? "";
          rows.push({
            id,
            label: d.label as string,
            key: d.observationKey as string,
            category: Number(d.category),
            version: Number(d.version),
            kind: Number(d.category) === 1 ? ("weather" as const) : ("flight" as const),
            unit: (p.unit === "mm" ? "mm" : "min") as "min" | "mm",
            cutoff: Number(d.cutoff),
            observationEnd: Number(d.observationEnd),
            locked: d.locked as bigint,
            engineStatus: Number(st.status),
            round: Number(st.round),
            capacity,
            capacityLeft: Math.max(0, capacity - lockedEth),
            windowText: date,
          });
        }
        if (alive) {
          setRaw(rows);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [read, block?.number]);

  const rows: EventRow[] | null = useMemo(() => {
    if (!raw) return null;
    return raw.map((r) => {
      const s = eventStatus(r.engineStatus, r.round, now, r.cutoff, r.observationEnd);
      return {
        ...r,
        status: s.status,
        statusLabel: s.label,
        policies: bound.filter((e) => Number(e.args.eventId) === r.id).length,
        cutoffText:
          now < r.cutoff ? fmtDuration(r.cutoff - now) : new Date(r.cutoff * 1000).toLocaleString(),
      };
    });
  }, [raw, now, bound]);

  return { events: rows, error, loading: rows === null && !error };
}
