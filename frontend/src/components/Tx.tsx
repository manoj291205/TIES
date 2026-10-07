import type { CSSProperties, ReactNode } from "react";
import { cx, fmtInt } from "../lib/format";
import { Icon, IconName, Spinner } from "./Icon";
import { Network, TxHash } from "./Display";

export type TxState = "idle" | "awaiting" | "rejected" | "pending" | "confirmed" | "reverted";

const TXS: Record<TxState, [IconName | "spinner", string, string]> = {
  idle: ["wallet", "Ready to sign", "Review the call, then confirm in MetaMask."],
  awaiting: [
    "wallet",
    "Confirm in MetaMask",
    "A signature request is open in your MetaMask window. Nothing is sent until you confirm.",
  ],
  rejected: [
    "x",
    "Request rejected in MetaMask",
    "You declined the signature. No transaction was sent and no gas was spent.",
  ],
  pending: ["spinner", "Transaction pending", "Broadcast to the network. Waiting to be mined."],
  confirmed: ["check", "Confirmed on-chain", "Mined and final on this network."],
  reverted: [
    "alert",
    "Transaction reverted",
    "The contract rejected the call. Gas for the attempt was spent.",
  ],
};

export interface TxFlowProps {
  state: TxState;
  title?: string;
  text?: string;
  /** Contract call being made, e.g. "PolicyBook.bind". */
  action?: string;
  hash?: string;
  network?: Network;
  submitted?: string;
  block?: number;
  gas?: number;
  gasEth?: string;
  result?: [string, ReactNode];
  /** Plain-language reason for a revert. */
  reason?: string;
  /** Raw custom error shown under the reason. */
  raw?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** The six transaction states every write passes through. */
export function TxFlow({
  state,
  title,
  text,
  action,
  hash,
  network,
  submitted,
  block,
  gas,
  gasEth,
  result,
  reason,
  raw,
  style,
  children,
}: TxFlowProps) {
  const s = TXS[state] ?? TXS.idle;
  const kv: [string, ReactNode][] = [];
  if (hash && state !== "awaiting" && state !== "rejected" && state !== "idle") {
    kv.push(["Tx hash", <TxHash hash={hash} network={network} copy />]);
  }
  if (state === "pending" && submitted) kv.push(["Submitted", submitted]);
  if (block && (state === "confirmed" || state === "reverted"))
    kv.push(["Block", `#${fmtInt(block)}`]);
  if (gas && (state === "confirmed" || state === "reverted")) {
    kv.push(["Gas used", fmtInt(gas) + (gasEth ? ` · ${gasEth} ETH` : "")]);
  }
  if (result && state === "confirmed") kv.push([result[0], result[1]]);
  if (raw && state === "reverted") kv.push(["Raw", raw]);
  return (
    <div
      className={cx("ties-tx", `ties-tx--${state}`)}
      role="status"
      aria-live="polite"
      style={style}
    >
      <div className="ties-tx__icon">{s[0] === "spinner" ? <Spinner /> : <Icon name={s[0]} />}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ties-row" style={{ justifyContent: "space-between" }}>
          <div className="ties-tx__title">{title ?? s[1]}</div>
          {action ? (
            <span className="ties-mono ties-subtle" style={{ fontSize: 12 }}>
              {action}
            </span>
          ) : null}
        </div>
        <div className="ties-tx__text">
          {state === "reverted" && reason ? reason : (text ?? s[2])}
        </div>
        {kv.length ? (
          <dl className="ties-tx__kv">
            {kv.map((r, i) => (
              <TxRow key={i} label={r[0]} value={r[1]} />
            ))}
          </dl>
        ) : null}
        {children ? (
          <div className="ties-row" style={{ marginTop: 12 }}>
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TxRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

type TrayState = "awaiting" | "pending" | "confirmed" | "reverted";
const TRAY_COLOR: Record<TrayState, string> = {
  pending: "var(--info-ink)",
  confirmed: "var(--pay-ink)",
  reverted: "var(--danger-ink)",
  awaiting: "var(--ink-muted)",
};

function TrayIcon({ state }: { state: TrayState }) {
  if (state === "pending") return <Spinner size={14} />;
  if (state === "confirmed") return <Icon name="check" size={14} />;
  if (state === "reverted") return <Icon name="alert" size={14} />;
  return <Icon name="wallet" size={14} />;
}

export interface TxTrayItem {
  label: string;
  state: TrayState;
  hash?: string;
  meta?: string;
  ago?: string;
}

export interface TxTrayProps {
  items: TxTrayItem[];
  network?: Network;
  style?: CSSProperties;
}

/** Persistent list of this session's transactions. */
export function TxTray({ items, network, style }: TxTrayProps) {
  const pending = items.filter((i) => i.state === "pending" || i.state === "awaiting").length;
  return (
    <div className="ties-tray" role="region" aria-label="Transactions" style={style}>
      <div className="ties-tray__head">
        <span className="ties-row" style={{ fontWeight: 600 }}>
          <Icon name="list" />
          Transactions
        </span>
        <span className="ties-mono ties-subtle" style={{ fontSize: 12 }}>
          {pending} pending · {items.length} this session
        </span>
      </div>
      {items.length ? (
        items.map((it, i) => (
          <div key={i} className="ties-tray__row">
            <span style={{ color: TRAY_COLOR[it.state], display: "inline-flex" }}>
              <TrayIcon state={it.state} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{it.label}</div>
              <div className="ties-subtle" style={{ fontSize: 12 }}>
                {it.hash ? <TxHash hash={it.hash} network={network} /> : "Waiting for signature"}
                {it.meta ? ` · ${it.meta}` : ""}
              </div>
            </div>
            <span className="ties-mono ties-subtle" style={{ fontSize: 11 }}>
              {it.ago ?? ""}
            </span>
          </div>
        ))
      ) : (
        <div className="ties-empty" style={{ padding: 24 }}>
          <p>No transactions in this session yet.</p>
        </div>
      )}
    </div>
  );
}

export interface TxToastProps {
  title: string;
  state?: "confirmed" | "reverted" | "pending";
  hash?: string;
  block?: number;
  gas?: number;
  text?: string;
  network?: Network;
  style?: CSSProperties;
  onDismiss?: () => void;
}

/** Toast for one mined (or reverted) transaction. */
export function TxToast({
  title,
  state = "confirmed",
  hash,
  block,
  gas,
  text,
  network,
  style,
  onDismiss,
}: TxToastProps) {
  return (
    <div
      className={cx("ties-toast", state === "reverted" && "ties-toast--reverted")}
      role="status"
      style={style}
    >
      <span style={{ color: TRAY_COLOR[state], display: "inline-flex", marginTop: 2 }}>
        <TrayIcon state={state} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div
          className="ties-subtle"
          style={{ fontSize: 12, marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          {hash ? <TxHash hash={hash} network={network} /> : null}
          {block ? <span className="ties-mono">#{fmtInt(block)}</span> : null}
          {gas ? <span className="ties-mono">{fmtInt(gas)} gas</span> : null}
        </div>
        {text ? (
          <div style={{ fontSize: 13, marginTop: 4, color: "var(--ink-muted)" }}>{text}</div>
        ) : null}
      </div>
      <button
        className="ties-btn ties-btn--ghost ties-btn--sm"
        style={{ padding: 4, height: 24 }}
        aria-label="Dismiss"
        type="button"
        onClick={onDismiss}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
