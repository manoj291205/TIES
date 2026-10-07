import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Button,
  EmptyState,
  EventLogRow,
  KeyValue,
  PageHeader,
  Panel,
  SegmentedControl,
} from "../components";
import { useNetwork } from "../hooks";
import { ChainEvent, useContractEvents } from "../hooks/data";
import { fmtEth, fmtInt, fmtWei } from "../lib/format";
import { formatUnits } from "ethers";

interface TxInfo {
  from: string;
  gasUsed: number;
  status: string;
  block: number;
  to: string;
  price: bigint;
}

const show = (v: unknown): string => {
  if (typeof v === "bigint") return v > 10n ** 15n ? `${fmtWei(v)} ETH?` : v.toString();
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  return String(v);
};
const argsText = (e: ChainEvent) =>
  Object.entries(e.args)
    .map(([k, v]) => `${k}=${typeof v === "bigint" ? v.toString() : show(v)}`)
    .join(" ");

/** Global live feed of decoded contract events; on localhost every tx hash link lands here. */
export function TxLog() {
  const { info, readProvider } = useNetwork();
  const [params, setParams] = useSearchParams();
  const txFilter = params.get("tx");
  const eventFilter = params.get("event");
  const [contract, setContract] = useState("all");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState(0);
  const all = useContractEvents();
  const [info2, setInfo2] = useState<Record<string, TxInfo>>({});

  useEffect(() => {
    if (!paused) setFrozen(all.length);
  }, [paused, all.length]);
  const visible = (paused ? all.slice(0, frozen) : all)
    .filter((e) => contract === "all" || e.contract === contract)
    .filter((e) => !txFilter || e.txHash === txFilter)
    .filter((e) => !eventFilter || String(e.args.eventId) === eventFilter)
    .slice()
    .reverse()
    .slice(0, 200);

  // Receipts for the rows on screen (cached).
  const hashes = useMemo(() => [...new Set(visible.map((e) => e.txHash))].slice(0, 60), [visible]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const next: Record<string, TxInfo> = {};
      for (const h of hashes) {
        if (info2[h]) continue;
        try {
          const [tx, rc] = await Promise.all([
            readProvider.getTransaction(h),
            readProvider.getTransactionReceipt(h),
          ]);
          if (tx && rc)
            next[h] = {
              from: tx.from,
              to: String(tx.to),
              gasUsed: Number(rc.gasUsed),
              status: rc.status === 1 ? "success" : "reverted",
              block: rc.blockNumber,
              price: rc.gasPrice,
            };
        } catch {
          /* leave blank */
        }
      }
      if (alive && Object.keys(next).length) setInfo2((p) => ({ ...p, ...next }));
    })();
    return () => {
      alive = false;
    };
  }, [hashes.join(",")]);

  const detail = txFilter ? info2[txFilter] : null;
  const contracts = ["all", ...new Set(all.map((e) => e.contract))];

  return (
    <>
      <PageHeader
        eyebrow="Settlement"
        title="Transaction & event log"
        subtitle="Every decoded event from the TIES contracts, newest first."
        actions={
          <Button
            variant="secondary"
            icon={paused ? "play" : "stop"}
            onClick={() => setPaused(!paused)}
          >
            {paused ? "Resume feed" : "Pause feed"}
          </Button>
        }
      />
      <div className="ties-row" style={{ gap: 16 }}>
        <SegmentedControl
          label="Contract"
          value={contract}
          onChange={setContract}
          options={contracts.map((c) => ({ value: c, label: c === "all" ? "All" : c }))}
        />
        {txFilter || eventFilter ? (
          <Button size="sm" variant="ghost" icon="x" onClick={() => setParams({})}>
            Clear filter
          </Button>
        ) : null}
        {paused && all.length > frozen ? (
          <span className="ties-chip ties-chip--info">{all.length - frozen} new events</span>
        ) : null}
      </div>
      {detail && txFilter ? (
        <Panel title="Transaction" icon="cube">
          <KeyValue
            items={[
              [
                "Hash",
                <span key="h" className="ties-mono" style={{ fontSize: 12 }}>
                  {txFilter}
                </span>,
              ],
              ["Status", detail.status],
              ["Block", `#${fmtInt(detail.block)}`],
              ["From", detail.from],
              ["To", detail.to],
              ["Gas used", fmtInt(detail.gasUsed)],
              [
                "Cost",
                `${fmtEth(Number(formatUnits(BigInt(detail.gasUsed) * detail.price, 18)), 6)} ${info.currency.symbol}`,
              ],
            ]}
          />
        </Panel>
      ) : null}
      <Panel title="Events" icon="list" flush>
        {visible.length === 0 ? (
          <EmptyState title="No events yet" body="Events appear as soon as they are mined." />
        ) : (
          <div role="table" aria-label="Contract events">
            {visible.map((e) => (
              <EventLogRow
                key={`${e.txHash}-${e.logIndex}`}
                block={e.block}
                name={e.name}
                contract={e.contract}
                args={argsText(e)}
                from={info2[e.txHash]?.from ?? e.address}
                tx={e.txHash}
                gas={info2[e.txHash]?.gasUsed}
                network={info.key}
              />
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
