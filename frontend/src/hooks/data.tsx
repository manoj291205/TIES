import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Interface, Log } from "ethers";
import { abiOf, ContractName } from "../lib/contracts";
import { useContracts, useNetwork, useWallet } from "./chain";

export interface ChainEvent {
  block: number;
  txHash: string;
  logIndex: number;
  contract: ContractName;
  address: string;
  name: string;
  args: Record<string, unknown>;
}

const LogsCtx = createContext<ChainEvent[]>([]);

/** One block subscription: fetch new logs of every TIES contract and decode them. */
export function LogsProvider({ children }: { children: ReactNode }) {
  const { deployment } = useContracts();
  const { block, readProvider } = useNetwork();
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const next = useRef(0);
  const key = deployment ? `${deployment.chainId}:${deployment.addresses.engine}` : "";

  const decoders = useMemo(() => {
    if (!deployment) return null;
    const names: [ContractName, string][] = [
      ["SettlementEngine", deployment.addresses.engine],
      ["PolicyBook", deployment.addresses.book],
      ["Vault", deployment.addresses.vault],
      ["TIESRegistry", deployment.addresses.registry],
    ];
    return new Map(
      names.map(([n, a]) => [a.toLowerCase(), { name: n, iface: new Interface(abiOf(n)) }]),
    );
  }, [deployment]);

  useEffect(() => {
    setEvents([]);
    next.current = deployment?.deployBlock ?? 0;
  }, [key]);

  useEffect(() => {
    if (!decoders || !block || block.number < next.current) return;
    let alive = true;
    const from = next.current;
    const to = block.number;
    readProvider
      .getLogs({ address: [...decoders.keys()], fromBlock: from, toBlock: to })
      .then((logs: Log[]) => {
        if (!alive) return;
        next.current = to + 1;
        const fresh: ChainEvent[] = [];
        for (const l of logs) {
          const d = decoders.get(l.address.toLowerCase());
          if (!d) continue;
          try {
            const p = d.iface.parseLog({ topics: [...l.topics], data: l.data });
            if (!p) continue;
            fresh.push({
              block: l.blockNumber,
              txHash: l.transactionHash,
              logIndex: l.index,
              contract: d.name,
              address: l.address,
              name: p.name,
              args: Object.fromEntries(p.fragment.inputs.map((inp, i) => [inp.name, p.args[i]])),
            });
          } catch {
            /* unknown event */
          }
        }
        if (fresh.length) setEvents((prev) => [...prev, ...fresh].slice(-5000));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [block?.number, decoders, readProvider]);

  return <LogsCtx.Provider value={events}>{children}</LogsCtx.Provider>;
}

/** Decoded contract events, optionally filtered by name and a predicate (e.g. one event id). */
export function useContractEvents(
  names?: string[],
  where?: (e: ChainEvent) => boolean,
): ChainEvent[] {
  const all = useContext(LogsCtx);
  return useMemo(
    () => all.filter((e) => (!names || names.includes(e.name)) && (!where || where(e))),
    [all, names, where],
  );
}

export const STATUS_NAMES = [
  "NONE",
  "ROUND_COMMIT",
  "ROUND_REVEAL",
  "DEFAULT_PENDING",
  "DISPUTED",
  "FINAL",
] as const;

export interface EventView {
  id: number;
  label: string;
  observationKey: string;
  category: number;
  cutoff: number;
  observationEnd: number;
  locked: bigint;
  status: (typeof STATUS_NAMES)[number];
  round: number;
  hasInterval: boolean;
  lower: bigint;
  upper: bigint;
  vLast: bigint;
  nEffLast: bigint;
  commitDeadline: number;
  revealDeadline: number;
  challengeDeadline: number;
  payCursor: number;
  noPayCursor: number;
  held: bigint;
  settledPay: bigint;
  settledNoPay: bigint;
  bucketCount: number;
}

/** State of one event, re-read on every new block. */
export function useEventState(eventId: number | null) {
  const { read } = useContracts();
  const { block } = useNetwork();
  const [view, setView] = useState<EventView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!read || eventId == null) {
      setView(null);
      setLoading(false);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const [data, st, held, pay, noPay] = await Promise.all([
          read.book.eventData(eventId),
          read.engine.eventState(eventId),
          read.engine.held(eventId),
          read.engine.payCursor(eventId),
          read.engine.noPayCursor(eventId),
        ]);
        if (!alive) return;
        setView({
          id: eventId,
          label: data.label,
          observationKey: data.observationKey,
          category: Number(data.category),
          cutoff: Number(data.cutoff),
          observationEnd: Number(data.observationEnd),
          locked: data.locked,
          status: STATUS_NAMES[Number(st.status)],
          round: Number(st.round),
          hasInterval: st.hasInterval,
          lower: st.lowerBound,
          upper: st.upperBound,
          vLast: st.vLast,
          nEffLast: st.nEffLast,
          commitDeadline: Number(st.commitDeadline),
          revealDeadline: Number(st.revealDeadline),
          challengeDeadline: Number(st.challengeDeadline),
          payCursor: Number(pay),
          noPayCursor: Number(noPay),
          held,
          settledPay: st.settledPay,
          settledNoPay: st.settledNoPay,
          bucketCount: Number(st.bucketCount),
        });
        setError(null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [read, eventId, block?.number]);

  return { view, error, loading };
}

/** Vault totals and the connected account's position, re-read on every new block. */
export function useVault() {
  const { read } = useContracts();
  const { block } = useNetwork();
  const { account } = useWallet();
  const [v, setV] = useState<{
    totalAssets: bigint;
    free: bigint;
    locked: bigint;
    claimable: bigint;
    shares: bigint;
    maxWithdraw: bigint;
  } | null>(null);
  useEffect(() => {
    if (!read) return setV(null);
    let alive = true;
    void (async () => {
      try {
        const [totalAssets, free, locked, claimable] = await Promise.all([
          read.vault.totalAssets(),
          read.vault.freeLiquidity(),
          read.vault.locked(),
          read.vault.claimable(),
        ]);
        const [shares, maxWithdraw] = account
          ? await Promise.all([read.vault.sharesOf(account), read.vault.maxWithdraw(account)])
          : [0n, 0n];
        if (alive) setV({ totalAssets, free, locked, claimable, shares, maxWithdraw });
      } catch {
        /* keep the last value */
      }
    })();
    return () => {
      alive = false;
    };
  }, [read, account, block?.number]);
  return v;
}

export type RoleName = "Policyholder" | "LP" | "Operator" | "Admin" | "Presenter";

/** Roles of the connected account, read from the chain (admin, registered oracle) and the network. */
export function useRoles() {
  const { read } = useContracts();
  const { account } = useWallet();
  const { info } = useNetwork();
  const [admin, setAdmin] = useState(false);
  const [operator, setOperator] = useState(false);
  const [active, setActive] = useState<RoleName | undefined>();
  useEffect(() => {
    if (!read || !account) {
      setAdmin(false);
      setOperator(false);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const a = await read.registry.hasRole(
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          account,
        );
        const o = await read.registry.isOracle(account);
        if (alive) {
          setAdmin(Boolean(a));
          setOperator(Boolean(o));
        }
      } catch {
        /* roles stay as they were */
      }
    })();
    return () => {
      alive = false;
    };
  }, [read, account]);
  const roles: RoleName[] = ["Policyholder", "LP"];
  if (operator) roles.push("Operator");
  if (admin) roles.push("Admin");
  if (info.key === "local") roles.push("Presenter");
  const role = active && roles.includes(active) ? active : roles[0];
  return { roles, role, setRole: setActive, admin, operator };
}
