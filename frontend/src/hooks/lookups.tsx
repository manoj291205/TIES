import { useEffect, useMemo, useState } from "react";
import { useContracts, useNetwork, useWallet } from "./chain";
import { useContractEvents } from "./data";

export interface SourceInfo {
  id: number;
  name: string;
  signer: string;
  category: number;
  active: boolean;
}

/** All registered sources (id to name, signer, category); re-read when the chain moves. */
export function useSources(): Map<number, SourceInfo> {
  const { read } = useContracts();
  const { block } = useNetwork();
  const [map, setMap] = useState<Map<number, SourceInfo>>(new Map());
  useEffect(() => {
    if (!read) return setMap(new Map());
    let alive = true;
    void (async () => {
      try {
        const count = Number(await read.registry.sourceCount());
        const next = new Map<number, SourceInfo>();
        for (let id = 1; id <= count; id++) {
          const s = await read.registry.getSource(id);
          next.set(id, {
            id,
            signer: s.signer,
            category: Number(s.category),
            active: s.active,
            name: s.name,
          });
        }
        if (alive) setMap(next);
      } catch {
        /* keep previous */
      }
    })();
    return () => {
      alive = false;
    };
  }, [read, block?.number]);
  return map;
}

/** Home source id of each oracle address for one category. */
export function useOracleSources(addresses: string[], category: number | undefined) {
  const { read } = useContracts();
  const [map, setMap] = useState<Record<string, number>>({});
  const key = addresses.join(",");
  useEffect(() => {
    if (!read || category == null || addresses.length === 0) return;
    let alive = true;
    void (async () => {
      const out: Record<string, number> = {};
      for (const a of addresses) {
        try {
          const o = await read.registry.getOracle(a, category);
          out[a.toLowerCase()] = Number(o.sourceId);
        } catch {
          /* unknown oracle */
        }
      }
      if (alive) setMap(out);
    })();
    return () => {
      alive = false;
    };
  }, [read, category, key]);
  return map;
}

export interface PolicyView {
  id: number;
  eventId: number;
  holder: string;
  bucket: number;
  claimed: boolean;
  payout: bigint;
  premium: bigint;
}

/** The connected account's policies. */
export function useMyPolicies() {
  const { read } = useContracts();
  const { account } = useWallet();
  const bound = useContractEvents(["PolicyBound"]);
  const claimed = useContractEvents(["Claimed"]);
  const [list, setList] = useState<PolicyView[] | null>(null);
  const boundCount = bound.length;
  const claimedCount = claimed.length;
  useEffect(() => {
    if (!read || !account) {
      setList([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const ids = (await read.book.policiesOf(account)) as bigint[];
        const out: PolicyView[] = [];
        for (const id of ids) {
          const p = await read.book.getPolicy(id);
          out.push({
            id: Number(id),
            eventId: Number(p.eventId),
            holder: p.holder,
            bucket: Number(p.bucket),
            claimed: p.claimed,
            payout: p.payout,
            premium: p.premium,
          });
        }
        if (alive) setList(out);
      } catch {
        if (alive) setList([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [read, account, boundCount, claimedCount]);
  return useMemo(() => list, [list]);
}
