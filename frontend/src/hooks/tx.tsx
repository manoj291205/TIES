import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ContractTransactionResponse, Interface } from "ethers";
import type { TxState, TxTrayItem } from "../components";
import { allInterfaces } from "../lib/contracts";
import { decodeError } from "../lib/errors";
import { useNetwork } from "./chain";

export interface TrackedTx extends TxTrayItem {
  id: number;
  at: number;
}

export interface ToastItem {
  id: number;
  title: string;
  state: "confirmed" | "reverted";
  hash?: string;
  block?: number;
  gas?: number;
  text?: string;
}

interface TxStore {
  items: TrackedTx[];
  toasts: ToastItem[];
  upsert: (item: Omit<TrackedTx, "at"> & { at?: number }) => void;
  toast: (t: Omit<ToastItem, "id">) => void;
  dismiss: (id: number) => void;
  nextId: () => number;
}

const Ctx = createContext<TxStore | null>(null);

export function TxProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<TrackedTx[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const nextId = useCallback(() => ++counter.current, []);
  const upsert: TxStore["upsert"] = useCallback((item) => {
    setItems((prev) => {
      const full = { ...item, at: item.at ?? Date.now() };
      const i = prev.findIndex((p) => p.id === item.id);
      if (i < 0) return [full, ...prev];
      const copy = prev.slice();
      copy[i] = { ...copy[i], ...full };
      return copy;
    });
  }, []);
  const toast: TxStore["toast"] = useCallback((t) => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { ...t, id }]);
    // Reverted toasts stay until dismissed; mined ones fade after a while.
    if (t.state === "confirmed")
      window.setTimeout(() => setToasts((p) => p.filter((x) => x.id !== id)), 8000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((p) => p.filter((x) => x.id !== id)), []);
  return (
    <Ctx.Provider value={{ items, toasts, upsert, toast, dismiss, nextId }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTxStore(): TxStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("TxProvider is missing");
  return s;
}

export interface TxFlowData {
  hash?: string;
  block?: number;
  gas?: number;
  reason?: string;
  raw?: string;
  /** Decoded contract events from the receipt, e.g. PolicyBound. */
  events: { name: string; args: Record<string, unknown> }[];
}

function decodeReceiptEvents(
  interfaces: Interface[],
  logs: readonly { topics: readonly string[]; data: string }[],
) {
  const out: TxFlowData["events"] = [];
  for (const log of logs) {
    for (const iface of interfaces) {
      try {
        const p = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (p) {
          out.push({
            name: p.name,
            args: Object.fromEntries(p.fragment.inputs.map((inp, i) => [inp.name, p.args[i]])),
          });
          break;
        }
      } catch {
        /* not this contract */
      }
    }
  }
  return out;
}

/**
 * Runs one write through the six states: idle, awaiting MetaMask, rejected | pending, then
 * confirmed | reverted. Every run also appears in the global tray and raises a toast when mined.
 */
export function useTx() {
  const store = useTxStore();
  const { readProvider } = useNetwork();
  const [state, setState] = useState<TxState>("idle");
  const [data, setData] = useState<TxFlowData>({ events: [] });

  const reset = useCallback(() => {
    setState("idle");
    setData({ events: [] });
  }, []);

  const run = useCallback(
    async (label: string, send: () => Promise<ContractTransactionResponse>) => {
      const id = store.nextId();
      const ifaces = allInterfaces().map((x) => x.iface);
      setData({ events: [] });
      setState("awaiting");
      store.upsert({ id, label, state: "awaiting" });
      let resp: ContractTransactionResponse;
      try {
        resp = await send();
      } catch (err) {
        const d = decodeError(err, ifaces);
        if (d.rejected) {
          setState("rejected");
          store.upsert({ id, label: `${label} (rejected)`, state: "reverted" });
        } else {
          setState("reverted");
          setData({ events: [], reason: `${d.message} No transaction was sent.`, raw: d.raw });
          store.upsert({ id, label, state: "reverted", meta: "not sent" });
          store.toast({ title: `${label} failed`, state: "reverted", text: d.message });
        }
        return null;
      }
      setState("pending");
      setData({ events: [], hash: resp.hash });
      store.upsert({ id, label, state: "pending", hash: resp.hash });
      try {
        const receipt = await resp.wait();
        if (!receipt) throw new Error("No receipt");
        const events = decodeReceiptEvents(ifaces, receipt.logs);
        const info = { hash: resp.hash, block: receipt.blockNumber, gas: Number(receipt.gasUsed) };
        setData({ ...info, events });
        setState("confirmed");
        store.upsert({ id, label, state: "confirmed", hash: resp.hash, meta: `#${info.block}` });
        store.toast({ title: label, state: "confirmed", ...info });
        return { receipt, events };
      } catch (err) {
        // A mined revert: replay the call at its block to read the custom error.
        let d = decodeError(err, ifaces);
        try {
          const tx = await readProvider.getTransaction(resp.hash);
          if (tx) {
            await readProvider.call({
              from: tx.from,
              to: tx.to,
              data: tx.data,
              value: tx.value,
              blockTag: tx.blockNumber ?? undefined,
            });
          }
        } catch (replay) {
          d = decodeError(replay, ifaces);
        }
        setState("reverted");
        setData({ hash: resp.hash, events: [], reason: d.message, raw: d.raw });
        store.upsert({ id, label, state: "reverted", hash: resp.hash });
        store.toast({
          title: `${label} reverted`,
          state: "reverted",
          hash: resp.hash,
          text: d.message,
        });
        return null;
      }
    },
    [store, readProvider],
  );

  return { state, data, run, reset };
}
