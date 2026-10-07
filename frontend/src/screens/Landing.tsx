import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, IntervalChart, PageHeader, Panel, StatTile, Stepper } from "../components";
import { useContracts, useNetwork, useWallet } from "../hooks";
import { useContractEvents } from "../hooks/data";
import { useEventList } from "../hooks/events";
import { fmtWei, weiToEth } from "../lib/format";

/** Landing: what TIES does, live stats, and a live chart of the most active event. */
export function Landing() {
  const nav = useNavigate();
  const { read } = useContracts();
  const { block } = useNetwork();
  const { account, connect } = useWallet();
  const { events } = useEventList();
  const claimed = useContractEvents(["Claimed"]);
  const bound = useContractEvents(["PolicyBound"]);
  const [assets, setAssets] = useState<bigint | null>(null);
  const [amounts, setAmounts] = useState<bigint[]>([]);
  const featured = [...(events ?? [])].sort((a, b) => Number(b.locked - a.locked))[0];

  useEffect(() => {
    if (!read) return;
    read.vault
      .totalAssets()
      .then(setAssets)
      .catch(() => undefined);
  }, [read, block?.number]);
  useEffect(() => {
    if (!read || !featured) return;
    read.book
      .bucketsInRange(featured.id, 0, featured.kind === "flight" ? 720 : 300)
      .then((a: bigint[]) => setAmounts([...a]))
      .catch(() => undefined);
  }, [read, featured?.id, bound.length]);

  const paid = claimed.reduce((a, c) => a + (c.args.amount as bigint), 0n);
  const buckets = amounts.map((a, x) => ({ x, amount: weiToEth(a) })).filter((b) => b.amount > 0);
  const lo = buckets.length ? Math.max(0, Math.min(...buckets.map((b) => b.x)) - 20) : 0;
  const hi = buckets.length ? Math.max(...buckets.map((b) => b.x)) + 20 : 160;

  return (
    <>
      <PageHeader
        eyebrow="Parametric cover"
        title="Insurance that settles on evidence, not on trust"
        subtitle="Cover for flight delays and rainfall. Independent, signed sources report; the contract turns their reports into an evidence interval and settles every policy on either side of it in one transaction."
        actions={
          <>
            {account ? (
              <Button onClick={() => nav("/markets")}>Browse events</Button>
            ) : (
              <Button icon="wallet" onClick={() => void connect().catch(() => undefined)}>
                Connect MetaMask
              </Button>
            )}
            <Button variant="secondary" onClick={() => nav("/docs")}>
              How it works
            </Button>
          </>
        }
      />
      <div className="ties-row" style={{ alignItems: "stretch", gap: 16 }}>
        <StatTile
          label="Events open"
          value={(events ?? []).filter((e) => e.status === "open").length}
          icon="grid"
        />
        <StatTile
          label="ETH in vault"
          value={assets === null ? "—" : fmtWei(assets)}
          unit="ETH"
          icon="vault"
        />
        <StatTile label="Policies bound" value={bound.length} icon="shield" />
        <StatTile label="Total paid out" tone="pay" value={fmtWei(paid)} unit="ETH" icon="check" />
      </div>
      <Panel title={featured ? `Live: ${featured.label}` : "Live chart"} icon="target">
        {featured && buckets.length ? (
          <IntervalChart
            domain={[lo, hi]}
            full={[0, featured.kind === "flight" ? 720 : 300]}
            buckets={buckets}
            unit={featured.unit}
            state="awaiting"
            overview={false}
            tableToggle={false}
            height={260}
          />
        ) : (
          <p className="ties-muted" style={{ margin: 0 }}>
            The chart appears once an event has cover.
          </p>
        )}
      </Panel>
      <Panel title="How it works" icon="book">
        <Stepper
          steps={[
            "Pick a threshold",
            "Sources report",
            "Interval narrows",
            "Settle by range",
            "Claim",
          ]}
          current={5}
        />
        <p className="ties-muted">
          Several oracle keys reading one source count once. If too much money sits inside the
          interval, the contract recruits sources it has not heard from. Settlement only moves
          forward.
        </p>
      </Panel>
    </>
  );
}
