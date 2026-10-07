import { useState } from "react";
import {
  Address,
  Amount,
  Banner,
  Button,
  CapacityMeter,
  DataTable,
  EmptyState,
  EscalationPanel,
  EventCard,
  EventLogRow,
  IntervalBar,
  IntervalChart,
  KeyValue,
  MoneySplit,
  NeffGauge,
  PageHeader,
  Panel,
  RoundTimeline,
  SegmentedControl,
  SourceList,
  Sparkline,
  StatTile,
  StatusChip,
  StatusKey,
  Stepper,
  TextField,
  ThresholdSlider,
  TxFlow,
  TxState,
  TxToast,
  TxTray,
  VerifiedOriginBadge,
} from "../components";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const H = "0x3f9a5b1e7c0d42a8e6f1b3c9d7a2e4f6081b5c3d9e7f2a4b6c8d0e1f3a5bc21e";

const STATUSES: StatusKey[] = [
  "open",
  "cutoff",
  "awaiting",
  "settling",
  "settled",
  "disputed",
  "bound",
  "held",
  "claimable",
  "claimed",
  "nopay",
  "pay",
  "insufficient",
  "escalating",
  "commit",
  "reveal",
  "pending",
  "confirmed",
  "rejected",
  "reverted",
  "honest",
  "compromised",
  "running",
  "stopped",
];
const TX_STATES: TxState[] = ["idle", "awaiting", "rejected", "pending", "confirmed", "reverted"];

/** Dev-only gallery (/__components) to compare each component with the design previews. */
export function Gallery() {
  const [threshold, setThreshold] = useState(120);
  const [seg, setSeg] = useState("a");
  return (
    <>
      <PageHeader
        eyebrow="Dev only"
        title="Component gallery"
        subtitle="Compare with frontend/ties-design/components/_previews."
      />
      <Panel title="Buttons and fields">
        <div className="ties-row">
          <Button>Buy cover</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="pay" icon="arrowDown">
            Claim 2.0000 ETH
          </Button>
          <Button variant="danger">Challenge</Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="ties-row" style={{ marginTop: 12, alignItems: "flex-start" }}>
          <TextField label="Payout" value="1.0000" suffix="ETH" mono hint="Locked as collateral" />
          <TextField label="Payout" value="0" suffix="ETH" mono error="Must be greater than zero" />
          <SegmentedControl
            label="Category"
            value={seg}
            onChange={setSeg}
            options={[
              { value: "a", label: "Flights", icon: "plane" },
              { value: "b", label: "Weather", icon: "rain" },
            ]}
          />
        </div>
      </Panel>
      <Panel title="Status chips">
        <div className="ties-row">
          {STATUSES.map((s) => (
            <StatusChip key={s} status={s} />
          ))}
          <VerifiedOriginBadge proof="mcp" />
          <VerifiedOriginBadge verified={false} />
        </div>
      </Panel>
      <Panel title="Stats, addresses, amounts">
        <div className="ties-row" style={{ alignItems: "stretch" }}>
          <StatTile label="Free liquidity" value="13.0000" unit="ETH" icon="vault" />
          <StatTile label="Held" value="3.0000" unit="ETH" tone="held" />
          <StatTile label="Loading" loading />
          <div className="ties-stack">
            <Address value={A} />
            <Amount value={3} />
            <Sparkline values={[0.8, 0.82, 0.79, 0.85, 0.9]} />
          </div>
        </div>
        <KeyValue
          items={[
            ["Block", "#1,284"],
            ["Gas", "142,318"],
          ]}
        />
      </Panel>
      <Panel title="Threshold slider and capacity">
        <ThresholdSlider
          value={threshold}
          onChange={setThreshold}
          histogram={[
            { x: 60, v: 1 },
            { x: 120, v: 2 },
            { x: 125, v: 5 },
            { x: 130, v: 1 },
          ]}
          capacityMax={10}
        />
        <CapacityMeter used={4.2} max={10} />
      </Panel>
      <Panel title="Interval chart (hero)">
        <IntervalChart
          domain={[100, 160]}
          bucketSize={1}
          L={118.4}
          U={141.2}
          V={129.6}
          prev={[[110, 150, "R1"]]}
          buckets={[
            { x: 60, amount: 1, mine: true },
            { x: 120, amount: 2 },
            { x: 126, amount: 1.5, mine: true },
            { x: 134, amount: 1.5 },
            { x: 150, amount: 1 },
          ]}
        />
        <IntervalBar min={0} max={720} threshold={126} L={118} U={141} />
      </Panel>
      <Panel title="Round timeline, sources, N_eff">
        <RoundTimeline
          domain={[100, 160]}
          ticks={[100, 120, 140, 160]}
          rounds={[
            { n: 1, L: 118.4, U: 141.2, V: 129.6, neff: 1.6, status: "insufficient" },
            { n: 2, L: 125.6, U: 136, V: 130.8, neff: 2.4, status: "settled" },
          ]}
          intersection={[125.6, 136]}
        />
        <SourceList
          reports={[
            {
              source: "Aggregator A",
              proof: "mcp",
              oracle: A,
              value: 131,
              weight: 0.5,
              sourceWeight: 0.6,
              block: 1263,
              tx: H,
              round: 1,
            },
            {
              source: "Aggregator A",
              proof: "mcp",
              oracle: A,
              value: 130,
              weight: 0.5,
              sourceWeight: 0.6,
              block: 1263,
              tx: H,
              round: 1,
            },
            {
              source: "ADS-B network",
              proof: "mcp",
              oracle: A,
              value: 133,
              weight: 0.9,
              sourceWeight: 0.9,
              block: 1279,
              tx: H,
              round: 2,
              isNew: true,
            },
          ]}
        />
        <NeffGauge value={1.6} min={1.8} detail="Two keys on one origin count once." />
        <MoneySplit
          segments={[
            { key: "pay", value: 3 },
            { key: "held", value: 2 },
            { key: "nopay", value: 4 },
          ]}
        />
        <EscalationPanel
          round={2}
          held={5}
          trigger={2}
          sources={["ADS-B network", "Airport FIDS"]}
          commit={["01:12", "closes in"]}
          received={1}
        />
      </Panel>
      <Panel title="Transactions">
        <div className="ties-stack">
          {TX_STATES.map((s) => (
            <TxFlow
              key={s}
              state={s}
              hash={H}
              block={1284}
              gas={142318}
              reason="Too much cover near this threshold."
              raw="CapacityWindowExceeded(120,..)"
            />
          ))}
        </div>
        <div className="ties-row" style={{ marginTop: 12, alignItems: "flex-start" }}>
          <TxToast title="PolicyBound" hash={H} block={1284} gas={142318} />
          <TxToast title="Bind reverted" state="reverted" text="Too much cover near 120." />
          <TxTray
            items={[
              { label: "Buy cover", state: "pending", hash: H },
              { label: "Claim", state: "confirmed", hash: H },
            ]}
          />
        </div>
      </Panel>
      <Panel title="Lists and states">
        <EventCard
          event={{
            id: 7,
            name: "AI 101 · DEL→BOM",
            kind: "flight",
            metric: "Arrival delay, minutes",
            window: "12 Oct",
            cutoff: "block #1,190",
            status: "settling",
            statusLabel: "Settling – Round 3",
            bound: 9,
            policies: 4,
            capacity: 40,
            capacityLeft: 31,
          }}
        />
        <EventLogRow
          block={1284}
          name="RoundFinalized"
          contract="SettlementEngine"
          args="eventId=7 round=2"
          from={A}
          tx={H}
          gas={142318}
        />
        <Stepper steps={["Pick", "Review", "Sign"]} current={1} />
        <DataTable columns={[{ title: "A", key: "a" }]} rows={[]} />
        <DataTable columns={[{ title: "A", key: "a" }]} loading />
        <EmptyState title="Nothing here yet" body="Empty state" />
        <EmptyState title="Could not load" error body="Error state" />
        <Banner tone="danger" title="Disputed">
          Intervals do not overlap.
        </Banner>
      </Panel>
    </>
  );
}
