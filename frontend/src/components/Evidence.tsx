import type { CSSProperties, ReactNode } from "react";
import { cx, fmtEth, fmtInt } from "../lib/format";
import { Icon } from "./Icon";
import { Button } from "./Controls";
import {
  Address,
  Amount,
  Network,
  StatusChip,
  StatusKey,
  TxHash,
  VerifiedOriginBadge,
} from "./Display";

// ------------------------------------------------------------------------- SourceList

export interface Report {
  source: string;
  proof: "zktls" | "enclave" | "mcp";
  verified?: boolean;
  oracle: string;
  value: number;
  weight: number | string;
  sourceWeight: number | string;
  block: number;
  tx: string;
  round: number;
  isNew?: boolean;
}

export interface SourceListProps {
  reports: Report[];
  unit?: string;
  network?: Network;
  style?: CSSProperties;
}

/** Reports grouped by attested origin; several keys on one origin count once. */
export function SourceList({ reports, unit = "min", network, style }: SourceListProps) {
  const groups = new Map<string, Report[]>();
  for (const r of reports) {
    const list = groups.get(r.source) ?? [];
    list.push(r);
    groups.set(r.source, list);
  }
  return (
    <div role="list" style={style}>
      {[...groups.entries()].map(([src, g]) => {
        const f = g[0];
        const dup = g.length > 1;
        return (
          <div key={src} role="listitem" className={cx("ties-src", f.isNew && "ties-src--new")}>
            <div style={{ minWidth: 0 }}>
              <div className="ties-src__name">
                {src}
                <VerifiedOriginBadge proof={f.proof} verified={f.verified} />
                {dup ? (
                  <span className="ties-chip ties-chip--held" style={{ height: 20 }}>
                    <Icon name="layers" size={12} />
                    {g.length} keys · counted once
                  </span>
                ) : null}
                {f.isNew ? (
                  <span className="ties-chip ties-chip--info" style={{ height: 20 }}>
                    New · round {f.round}
                  </span>
                ) : null}
              </div>
              <div className="ties-src__meta" style={{ marginTop: 4 }}>
                <Address value={f.oracle} label="oracle" copy={false} />
                <span className="ties-mono">w {f.weight}</span>
                <span className="ties-mono">#{fmtInt(f.block)}</span>
                <TxHash hash={f.tx} network={network} />
              </div>
            </div>
            <div className="ties-src__val">
              {f.value}
              <span className="ties-subtle" style={{ fontSize: 11, marginLeft: 3 }}>
                {unit}
              </span>
              {dup ? (
                <div className="ties-mono ties-subtle" style={{ fontSize: 11, fontWeight: 400 }}>
                  source weight {f.sourceWeight}
                </div>
              ) : null}
            </div>
            {dup ? (
              <div className="ties-src__group">
                {g.slice(1).map((r, i) => (
                  <div key={i} className="ties-src__dup">
                    <Icon name="chevronRight" size={12} />
                    <Address value={r.oracle} label="oracle" copy={false} />
                    <span className="ties-mono">
                      {r.value} {unit}
                    </span>
                    <span className="ties-mono">#{fmtInt(r.block)}</span>
                    <TxHash hash={r.tx} network={network} />
                    <span className="ties-subtle">same origin — merged</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------------- NeffGauge

export interface NeffGaugeProps {
  value: number;
  min: number;
  max?: number;
  detail?: ReactNode;
  style?: CSSProperties;
}

/** Effective number of independent sources against the required minimum. */
export function NeffGauge({ value, min, max = 4, detail, style }: NeffGaugeProps) {
  const ok = value >= min;
  const pc = (v: number) => Math.min(100, (v / max) * 100);
  return (
    <div style={style}>
      <div className="ties-row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <div className="ties-row" style={{ alignItems: "baseline", gap: 8 }}>
          <span
            style={{
              font: "500 32px/40px var(--font-mono)",
              color: ok ? "var(--ink)" : "var(--held-ink)",
            }}
          >
            {value.toFixed(1)}
          </span>
          <span className="ties-subtle" style={{ fontSize: 13 }}>
            effective independent sources
          </span>
        </div>
        <StatusChip
          status={ok ? "pay" : "insufficient"}
          label={ok ? "Meets minimum" : "Below minimum"}
          tone={ok ? "pay" : "held"}
        />
      </div>
      <div
        className="ties-gauge__track"
        style={{ marginTop: 28 }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={`N_eff ${value}, minimum ${min}`}
      >
        <div
          className={cx("ties-gauge__fill", ok ? "ties-fill-pay" : "ties-fill-held")}
          style={{ width: `${pc(value)}%` }}
        />
        <div className="ties-gauge__min" style={{ left: `${pc(min)}%` }}>
          <span className="ties-gauge__minlabel">min {min}</span>
        </div>
      </div>
      <div
        className="ties-row ties-mono ties-subtle"
        style={{ justifyContent: "space-between", fontSize: 11, marginTop: 4 }}
      >
        {[0, 1, 2, 3, 4]
          .filter((v) => v <= max)
          .map((v) => (
            <span key={v}>{v}</span>
          ))}
      </div>
      {detail ? (
        <div className="ties-field__hint" style={{ marginTop: 8 }}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------- MoneySplit

export type SplitKey = "pay" | "nopay" | "held" | "free" | "locked" | "claimable";

const SEG: Record<SplitKey, [string, string]> = {
  pay: ["ties-fill-pay", "Settled pay"],
  nopay: ["ties-fill-nopay", "Settled no pay"],
  held: ["ties-fill-held", "Held"],
  free: ["ties-fill-free", "Free"],
  locked: ["ties-fill-locked", "Locked"],
  claimable: ["ties-fill-claimable", "Claimable"],
};

export interface MoneySegment {
  key: SplitKey;
  value: number;
  label?: string;
  sub?: ReactNode;
}

export interface MoneySplitProps {
  segments: MoneySegment[];
  total?: number;
  title?: string | false;
  decimals?: number;
  barHeight?: number;
  style?: CSSProperties;
}

/** A stacked bar with a labelled amount per segment. */
export function MoneySplit({
  segments,
  total,
  title,
  decimals,
  barHeight = 14,
  style,
}: MoneySplitProps) {
  const tot = total ?? segments.reduce((a, s) => a + s.value, 0);
  return (
    <div style={style}>
      {title !== false ? (
        <div className="ties-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <span className="ties-label">{title ?? "Total"}</span>
          <Amount value={tot} decimals={decimals} />
        </div>
      ) : null}
      <div
        className="ties-split"
        style={{ height: barHeight }}
        role="img"
        aria-label={segments.map((s) => `${s.label ?? SEG[s.key][1]} ${s.value} ETH`).join(", ")}
      >
        {segments.map((s) =>
          s.value > 0 ? (
            <i key={s.key} className={SEG[s.key][0]} style={{ flex: s.value }} />
          ) : null,
        )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${segments.length}, minmax(0,1fr))`,
          gap: 12,
          marginTop: 12,
        }}
      >
        {segments.map((s) => (
          <div key={s.key}>
            <div className="ties-row" style={{ gap: 6, fontSize: 12, color: "var(--ink-muted)" }}>
              <i className={`ties-sw ${SEG[s.key][0]}`} />
              {s.label ?? SEG[s.key][1]}
            </div>
            <div style={{ marginTop: 2, fontSize: 15, fontWeight: 500 }}>
              <Amount value={s.value} decimals={decimals} />
            </div>
            {s.sub ? (
              <div className="ties-subtle" style={{ fontSize: 12 }}>
                {s.sub}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- EscalationPanel

export interface EscalationPanelProps {
  round: number;
  held: number;
  trigger: number;
  /** Names of the sources being recruited. */
  sources: string[];
  phase?: "commit" | "reveal";
  /** [value, caption] shown in the commit and reveal boxes (e.g. a countdown). */
  commit?: [string, string];
  reveal?: [string, string];
  received?: number;
  style?: CSSProperties;
}

export function EscalationPanel({
  round,
  held,
  trigger,
  sources,
  phase = "commit",
  commit,
  reveal,
  received,
  style,
}: EscalationPanelProps) {
  const boxes: [string, "commit" | "reveal", [string, string] | undefined][] = [
    ["Commit", "commit", commit],
    ["Reveal", "reveal", reveal],
  ];
  return (
    <div className="ties-stack" style={{ gap: 12, ...style }}>
      <div
        style={{
          padding: 12,
          borderRadius: "var(--radius-sm)",
          background: "var(--held-wash)",
          border: "1px solid var(--held)",
        }}
      >
        <div className="ties-row" style={{ color: "var(--held-ink)", fontWeight: 600 }}>
          <Icon name="layers" />
          Escalation requested · Round {round}
        </div>
        <div className="ties-mono" style={{ marginTop: 6, fontSize: 13 }}>
          Held <b>{fmtEth(held, 1)} ETH</b> &gt; trigger {fmtEth(trigger, 1)} ETH
        </div>
        <div style={{ fontSize: 13, marginTop: 2 }}>
          → requesting {sources.length} new source{sources.length === 1 ? "" : "s"}:{" "}
          <b>{sources.join(", ")}</b>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {boxes.map(([title, key, data]) => {
          const active = phase === key;
          const done = phase === "reveal" && key === "commit";
          return (
            <div
              key={key}
              style={{
                padding: 10,
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`,
                background: active ? "var(--surface-1)" : "var(--surface-2)",
              }}
            >
              <div className="ties-row" style={{ justifyContent: "space-between" }}>
                <span className="ties-label">{title} window</span>
                {done ? (
                  <Icon name="check" size={14} style={{ color: "var(--pay-ink)" }} />
                ) : active ? (
                  <span className="ties-dot ties-pulse" style={{ background: "var(--info)" }} />
                ) : null}
              </div>
              <div className="ties-mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 4 }}>
                {data ? data[0] : "—"}
              </div>
              <div className="ties-subtle" style={{ fontSize: 12 }}>
                {data ? data[1] : ""}
              </div>
            </div>
          );
        })}
      </div>
      {received != null ? (
        <div
          className="ties-row ties-subtle"
          style={{ fontSize: 12, justifyContent: "space-between" }}
        >
          <span>Commits received</span>
          <span className="ties-mono">
            {received} / {sources.length}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------- EventCard

export interface EventCardData {
  id: number;
  name: string;
  kind: "flight" | "weather";
  metric: string;
  window: string;
  cutoff: string;
  status: StatusKey;
  statusLabel?: string;
  bound: number;
  policies: number;
  capacity: number;
  capacityLeft: number;
}

export interface EventCardProps {
  event: EventCardData;
  style?: CSSProperties;
  onBuy?: () => void;
  onView?: () => void;
}

export function EventCard({ event: e, style, onBuy, onView }: EventCardProps) {
  const capPct = e.capacity > 0 ? Math.round((1 - e.capacityLeft / e.capacity) * 100) : 0;
  return (
    <article className="ties-card" style={style}>
      <div
        className="ties-row"
        style={{ justifyContent: "space-between", alignItems: "flex-start" }}
      >
        <span className="ties-chip ties-chip--outline">
          <Icon name={e.kind === "weather" ? "rain" : "plane"} size={12} />
          {e.kind === "weather" ? "Weather" : "Flight"}
        </span>
        <StatusChip status={e.status} label={e.statusLabel} />
      </div>
      <div>
        <div className="ties-card__title">{e.name}</div>
        <div className="ties-subtle" style={{ fontSize: 12, marginTop: 2 }}>
          {e.metric}
        </div>
      </div>
      <dl className="ties-kv">
        <dt>Observation window</dt>
        <dd>{e.window}</dd>
        <dt>{e.status === "open" ? "Binding cutoff" : "Cutoff"}</dt>
        <dd style={e.status === "open" ? { color: "var(--ink)", fontWeight: 600 } : undefined}>
          {e.cutoff}
        </dd>
        <dt>Cover bound</dt>
        <dd>
          {fmtEth(e.bound, 2)} ETH · {e.policies} policies
        </dd>
      </dl>
      <div>
        <div
          className="ties-row"
          style={{ justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}
        >
          <span className="ties-muted">Remaining capacity</span>
          <span className="ties-mono">
            {fmtEth(e.capacityLeft, 2)} / {fmtEth(e.capacity, 0)} ETH
          </span>
        </div>
        <div className="ties-meter">
          <i className="ties-fill-info" style={{ width: `${capPct}%` }} />
        </div>
      </div>
      <div className="ties-row" style={{ justifyContent: "space-between", marginTop: "auto" }}>
        <span className="ties-mono ties-subtle" style={{ fontSize: 11 }}>
          event #{e.id}
        </span>
        {e.status === "open" ? (
          <Button size="sm" onClick={onBuy}>
            Buy cover
          </Button>
        ) : (
          <Button size="sm" variant="secondary" iconRight="chevronRight" onClick={onView}>
            View settlement
          </Button>
        )}
      </div>
    </article>
  );
}

// -------------------------------------------------------------------------- EventLogRow

type ChipTone = "neutral" | "pay" | "held" | "nopay" | "danger" | "info" | "outline";

/** Tone of each contract event's chip in the log. */
export const EVENT_TONE: Record<string, ChipTone> = {
  PolicyBound: "neutral",
  ReportCommitted: "info",
  ReportRevealed: "info",
  RoundOpened: "info",
  RoundFinalized: "pay",
  EscalationRequested: "held",
  EventDefaultPending: "held",
  EventChallenged: "danger",
  EventDisputed: "danger",
  DefaultApplied: "neutral",
  DisputeResolved: "neutral",
  EventFinalized: "pay",
  Claimed: "pay",
  Deposit: "neutral",
  Withdraw: "neutral",
  ReputationUpdated: "outline",
  DependenceUpdated: "outline",
  CategoryUpdated: "outline",
  EventCreated: "outline",
};

export interface EventLogRowProps {
  block: number;
  name: string;
  contract: string;
  args: string;
  from: string;
  tx: string;
  gas?: number | null;
  network?: Network;
  style?: CSSProperties;
}

export function EventLogRow({
  block,
  name,
  contract,
  args,
  from,
  tx,
  gas,
  network,
  style,
}: EventLogRowProps) {
  return (
    <div className="ties-log" role="row" style={style}>
      <span className="ties-mono" role="cell" style={{ fontSize: 12 }}>
        #{fmtInt(block)}
      </span>
      <div role="cell" style={{ minWidth: 0 }}>
        <div className="ties-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <span
            className={`ties-chip ties-chip--${EVENT_TONE[name] ?? "neutral"}`}
            style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
          >
            {name}
          </span>
          <span className="ties-muted" style={{ fontSize: 12 }}>
            {contract}
          </span>
        </div>
        <div className="ties-log__args" title={args} style={{ marginTop: 3 }}>
          {args}
        </div>
      </div>
      <span role="cell">
        <Address value={from} copy={false} />
      </span>
      <span role="cell">
        <TxHash hash={tx} network={network} />
      </span>
      <span
        className="ties-mono ties-subtle"
        role="cell"
        style={{ fontSize: 12, textAlign: "right" }}
      >
        {gas ? fmtInt(gas) : "—"}
      </span>
    </div>
  );
}
