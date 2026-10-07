import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { cx, fmtEth, shortAddr } from "../lib/format";
import { Icon, IconName, Spinner } from "./Icon";

export type Network = "local" | "sepolia";
export type Tone = "neutral" | "pay" | "held" | "nopay" | "danger" | "info" | "outline";
export type StatusKey =
  | "open"
  | "cutoff"
  | "awaiting"
  | "settling"
  | "settled"
  | "disputed"
  | "bound"
  | "held"
  | "claimable"
  | "claimed"
  | "nopay"
  | "pay"
  | "insufficient"
  | "escalating"
  | "commit"
  | "reveal"
  | "pending"
  | "confirmed"
  | "rejected"
  | "reverted"
  | "honest"
  | "compromised"
  | "running"
  | "stopped";

/** tone, icon, default label: the fixed status vocabulary of the design. */
export const STATUS: Record<StatusKey, [Tone, IconName | "spinner", string]> = {
  open: ["info", "dot", "Open for cover"],
  cutoff: ["neutral", "clock", "Cutoff passed"],
  awaiting: ["info", "hourglass", "Awaiting evidence"],
  settling: ["held", "refresh", "Settling"],
  settled: ["neutral", "check", "Settled"],
  disputed: ["danger", "flag", "Disputed"],
  bound: ["neutral", "lock", "Bound"],
  held: ["held", "lock", "Held — inside evidence interval"],
  claimable: ["pay", "arrowDown", "Claimable"],
  claimed: ["pay", "check", "Claimed"],
  nopay: ["nopay", "minus", "Settled — condition not met"],
  pay: ["pay", "check", "Settled pay"],
  insufficient: ["held", "alert", "Need ≥ 2 independent sources"],
  escalating: ["held", "layers", "Escalating"],
  pending: ["info", "spinner", "Pending"],
  confirmed: ["neutral", "check", "Confirmed"],
  rejected: ["nopay", "x", "Rejected"],
  reverted: ["danger", "alert", "Reverted"],
  honest: ["neutral", "shield", "Honest"],
  compromised: ["danger", "alert", "Compromised"],
  running: ["info", "spinner", "Running"],
  stopped: ["neutral", "stop", "Stopped"],
  commit: ["info", "lock", "Commit open"],
  reveal: ["held", "eye", "Reveal open"],
};

export interface StatusChipProps {
  status: StatusKey;
  /** Overrides the default text, e.g. "Settling – Round 2". */
  label?: string;
  tone?: Tone;
  title?: string;
  className?: string;
}

/** Status word with an icon; never colour alone. */
export function StatusChip({ status, label, tone, title, className }: StatusChipProps) {
  const s = STATUS[status] ?? (["neutral", "dot", status] as const);
  return (
    <span className={cx("ties-chip", `ties-chip--${tone ?? s[0]}`, className)} title={title}>
      {s[1] === "spinner" ? (
        <Spinner size={12} />
      ) : (
        <Icon name={s[1]} size={12} strokeWidth={1.8} />
      )}
      {label ?? s[2]}
    </span>
  );
}

const PROOF = { zktls: "zkTLS", enclave: "Enclave", mcp: "Signed MCP" } as const;

export interface VerifiedOriginBadgeProps {
  proof?: keyof typeof PROOF;
  verified?: boolean;
}

/** Proof of upstream origin for a report. */
export function VerifiedOriginBadge({ proof = "mcp", verified }: VerifiedOriginBadgeProps) {
  if (verified === false) {
    return (
      <span
        className="ties-verified ties-verified--unverified"
        title="Origin proof failed — report ignored"
      >
        <Icon name="x" size={12} />
        <b>Unverified</b>
      </span>
    );
  }
  return (
    <span className="ties-verified" title={`Origin proven on-chain via ${PROOF[proof]}`}>
      <span style={{ color: "var(--pay-ink)", display: "inline-flex" }}>
        <Icon name="shield" size={13} />
      </span>
      <b>Verified origin</b>
      <span>· {PROOF[proof]}</span>
    </span>
  );
}

export function Skeleton({ w = "100%", h = 12 }: { w?: number | string; h?: number }) {
  return <span className="ties-skel" style={{ width: w, height: h }} aria-hidden="true" />;
}

export interface StatTileProps {
  label: string;
  value?: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: "pay" | "held" | "danger";
  icon?: IconName;
  loading?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}

export function StatTile({
  label,
  value,
  unit,
  sub,
  tone,
  icon,
  loading,
  style,
  children,
}: StatTileProps) {
  return (
    <div className={cx("ties-stat", tone && `ties-stat--${tone}`)} style={style}>
      <div className="ties-row" style={{ justifyContent: "space-between" }}>
        <span className="ties-label">{label}</span>
        {icon ? (
          <span className="ties-subtle" style={{ display: "inline-flex" }}>
            <Icon name={icon} />
          </span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton w={120} h={28} />
      ) : (
        <div className="ties-stat__value">
          {value}
          {unit ? <span className="ties-stat__unit">{unit}</span> : null}
        </div>
      )}
      {sub ? <div className="ties-stat__sub">{sub}</div> : null}
      {children}
    </div>
  );
}

function CopyButton({ value, what = "address" }: { value: string; what?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : `Copy ${what}`}
      title={copied ? "Copied" : "Copy"}
      onClick={() => {
        void navigator.clipboard?.writeText(value).catch(() => undefined);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={13} />
    </button>
  );
}

export interface AddressProps {
  value: string;
  label?: string;
  copy?: boolean;
}

/** Shortened 0x address with a copy button; the full value is in the tooltip. */
export function Address({ value, label, copy = true }: AddressProps) {
  return (
    <span className="ties-addr" title={value}>
      {label ? (
        <span style={{ fontFamily: "var(--font-sans)", color: "var(--ink-muted)" }}>{label}</span>
      ) : null}
      {shortAddr(value)}
      {copy ? <CopyButton value={value} /> : null}
    </span>
  );
}

export interface TxHashProps {
  hash: string;
  network?: Network;
  copy?: boolean;
}

/** Tx hash link: Sepolia opens the block explorer, localhost opens the in-app transaction log. */
export function TxHash({ hash, network = "local", copy }: TxHashProps) {
  const sepolia = network === "sepolia";
  const href = sepolia ? `https://sepolia.etherscan.io/tx/${hash}` : `#/log?tx=${hash}`;
  return (
    <span className="ties-addr">
      <a
        href={href}
        className="ties-link"
        title={sepolia ? "Open in block explorer" : "Open in transaction log"}
        {...(sepolia ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {shortAddr(hash)}
      </a>
      {sepolia ? (
        <span className="ties-subtle" style={{ display: "inline-flex" }}>
          <Icon name="external" size={12} />
        </span>
      ) : null}
      {copy ? <CopyButton value={hash} what="hash" /> : null}
    </span>
  );
}

export interface AmountProps {
  value: number | null | undefined;
  decimals?: number;
  unit?: string | false;
  sign?: string;
  style?: CSSProperties;
}

/** ETH amount, 4 decimals by default, unit in a muted style. */
export function Amount({ value, decimals, unit = "ETH", sign = "", style }: AmountProps) {
  return (
    <span className="ties-amt" style={style}>
      {sign + fmtEth(value, decimals)}
      {unit === false ? null : <small>{unit}</small>}
    </span>
  );
}

export type BannerTone = "danger" | "held" | "pay" | "info" | "neutral";
const BANNER_ICON: Record<BannerTone, IconName> = {
  danger: "flag",
  held: "alert",
  pay: "check",
  info: "info",
  neutral: "info",
};

export interface BannerProps {
  tone?: BannerTone;
  title: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Banner({ tone = "info", title, icon, actions, style, children }: BannerProps) {
  return (
    <div
      className={`ties-banner ties-banner--${tone}`}
      role={tone === "danger" ? "alert" : "status"}
      style={style}
    >
      <span className="ties-banner__icon" style={{ display: "inline-flex", marginTop: 2 }}>
        <Icon name={icon ?? BANNER_ICON[tone]} size={18} />
      </span>
      <div className="ties-banner__body">
        <div className="ties-banner__title">{title}</div>
        {children ? <div className="ties-banner__text">{children}</div> : null}
      </div>
      {actions ? (
        <div className="ties-row" style={{ flex: "none" }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  body?: ReactNode;
  icon?: IconName;
  error?: boolean;
  action?: ReactNode;
  style?: CSSProperties;
}

export function EmptyState({ title, body, icon, error, action, style }: EmptyStateProps) {
  return (
    <div className={cx("ties-empty", error && "ties-empty--error")} style={style}>
      <div className="ties-empty__icon">
        <Icon name={icon ?? (error ? "alert" : "list")} size={20} />
      </div>
      <h4>{title}</h4>
      {body ? <p>{body}</p> : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export interface PanelProps {
  title?: ReactNode;
  icon?: IconName;
  badge?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  children?: ReactNode;
}

export function Panel({
  title,
  icon,
  badge,
  actions,
  footer,
  flush,
  className,
  style,
  bodyStyle,
  children,
}: PanelProps) {
  return (
    <section
      className={cx("ties-panel", className)}
      style={style}
      aria-label={typeof title === "string" ? title : undefined}
    >
      {title ? (
        <div className="ties-panel__head">
          <div className="ties-panel__title">
            {icon ? <Icon name={icon} /> : null}
            {title}
            {badge ?? null}
          </div>
          {actions ? <div className="ties-row">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cx("ties-panel__body", flush && "ties-panel__body--flush")} style={bodyStyle}>
        {children}
      </div>
      {footer ? <div className="ties-panel__foot">{footer}</div> : null}
    </section>
  );
}

export interface KeyValueProps {
  items: [ReactNode, ReactNode, CSSProperties?][];
  style?: CSSProperties;
}

export function KeyValue({ items, style }: KeyValueProps) {
  return (
    <dl className="ties-kv" style={style}>
      {items.map((it, i) => (
        <KeyValueRow key={i} label={it[0]} value={it[1]} valueStyle={it[2]} />
      ))}
    </dl>
  );
}

function KeyValueRow({
  label,
  value,
  valueStyle,
}: {
  label: ReactNode;
  value: ReactNode;
  valueStyle?: CSSProperties;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd style={valueStyle}>{value}</dd>
    </>
  );
}

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  label?: string;
}

export function Sparkline({ values, width = 96, height = 24, color, label }: SparklineProps) {
  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const range = mx - mn || 1;
  const pts = values.map((y, i): [number, number] => [
    (i / Math.max(values.length - 1, 1)) * (width - 4) + 2,
    height - 3 - ((y - mn) / range) * (height - 6),
  ]);
  const last = pts[pts.length - 1] ?? [0, 0];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? `Trend from ${values[0]} to ${values[values.length - 1]}`}
    >
      <polyline
        points={pts.map((p) => p.join(",")).join(" ")}
        style={{
          fill: "none",
          stroke: color ?? "var(--ink-muted)",
          strokeWidth: 1.5,
          strokeLinejoin: "round",
        }}
      />
      <circle cx={last[0]} cy={last[1]} r={2.5} style={{ fill: color ?? "var(--ink)" }} />
    </svg>
  );
}

export interface StepperProps {
  steps: string[];
  current: number;
  style?: CSSProperties;
}

export function Stepper({ steps, current, style }: StepperProps) {
  return (
    <ol
      className="ties-steps"
      style={{ listStyle: "none", margin: 0, padding: 0, ...style }}
      aria-label="Progress"
    >
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <StepItem key={i} index={i} state={state}>
            {s}
          </StepItem>
        );
      })}
    </ol>
  );
}

function StepItem({
  index,
  state,
  children,
}: {
  index: number;
  state: "done" | "current" | "todo";
  children: ReactNode;
}) {
  return (
    <>
      {index > 0 ? <li className="ties-step__line" aria-hidden="true" /> : null}
      <li
        className={`ties-step ties-step--${state}`}
        aria-current={state === "current" ? "step" : undefined}
      >
        <span className="ties-step__n">
          {state === "done" ? <Icon name="check" size={12} strokeWidth={2} /> : index + 1}
        </span>
        {children}
      </li>
    </>
  );
}

export interface DataTableColumn<Row> {
  title: ReactNode;
  key?: keyof Row & string;
  num?: boolean;
  render?: (row: Row) => ReactNode;
  thStyle?: CSSProperties;
  style?: CSSProperties;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows?: (Row & { _className?: string })[];
  loading?: boolean;
  empty?: ReactNode;
  caption?: string;
  style?: CSSProperties;
}

/** Table with the three required list states: loading skeleton, empty, rows. */
export function DataTable<Row>({
  columns,
  rows,
  loading,
  empty,
  caption,
  style,
}: DataTableProps<Row>) {
  let body: ReactNode;
  if (loading) {
    body = [0, 1, 2, 3].map((i) => (
      <tr key={i}>
        {columns.map((_c, j) => (
          <td key={j}>
            <Skeleton w={`${40 + ((i * 7 + j * 13) % 50)}%`} />
          </td>
        ))}
      </tr>
    ));
  } else if (!rows || rows.length === 0) {
    body = (
      <tr>
        <td colSpan={columns.length} style={{ padding: 0 }}>
          {empty ?? <EmptyState title="Nothing here yet" />}
        </td>
      </tr>
    );
  } else {
    body = rows.map((r, i) => (
      <tr key={i} className={r._className}>
        {columns.map((c, j) => (
          <td key={j} className={c.num ? "num" : undefined} style={c.style}>
            {c.render ? c.render(r) : c.key ? (r[c.key] as ReactNode) : null}
          </td>
        ))}
      </tr>
    ));
  }
  return (
    <table className="ties-table" style={style} aria-busy={loading ? true : undefined}>
      {caption ? <caption className="ties-sr">{caption}</caption> : null}
      <thead>
        <tr>
          {columns.map((c, j) => (
            <th key={j} className={c.num ? "num" : undefined} style={c.thStyle}>
              {c.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  );
}
