import { useId, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { cx, fmtEth } from "../lib/format";
import { Icon } from "./Icon";
import { Network, StatusChip, StatusKey, TxHash } from "./Display";

// ----------------------------------------------------------------------- ThresholdSlider

export interface HistogramBar {
  x: number;
  v: number;
}

export interface ThresholdSliderProps {
  min?: number;
  max?: number;
  value: number;
  unit?: "min" | "mm";
  metric?: string;
  /** Step of the arrow keys (one bucket); Shift moves six steps. */
  bucket?: number;
  /** Half-width of the capacity window, in buckets. */
  window?: number;
  histogram?: HistogramBar[];
  capacityMax?: number;
  error?: boolean;
  ticks?: number[];
  style?: CSSProperties;
  onChange?: (value: number) => void;
}

/** Threshold picker with the bound-cover histogram and the capacity window. */
export function ThresholdSlider({
  min = 0,
  max = 720,
  value,
  unit = "min",
  metric = "delay",
  bucket = 1,
  window: win = 15,
  histogram = [],
  capacityMax,
  error,
  ticks = [0, 120, 240, 360, 480, 600, 720],
  style,
  onChange,
}: ThresholdSliderProps) {
  const pct = (x: number) => ((x - min) / (max - min)) * 100;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? bucket * 6 : bucket;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      onChange?.(Math.min(max, value + step));
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      onChange?.(Math.max(min, value - step));
      e.preventDefault();
    }
  };
  const used = histogram.filter((b) => Math.abs(b.x - value) <= win).reduce((t, b) => t + b.v, 0);
  const hmax = Math.max(1, ...histogram.map((b) => b.v));
  const lo = Math.max(min, value - win);
  const hi = Math.min(max, value + win);
  const pointer = (clientX: number, rail: HTMLElement) => {
    const r = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    onChange?.(Math.round((min + ratio * (max - min)) / bucket) * bucket);
  };
  return (
    <div className="ties-slider" style={{ paddingTop: 30, ...style }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: `${pct(value)}%`,
          transform: "translateX(-50%)",
          font: "600 12px/16px var(--font-mono)",
          background: "var(--ink)",
          color: "var(--ink-inverse)",
          padding: "3px 7px",
          borderRadius: 3,
          whiteSpace: "nowrap",
        }}
      >
        pays if ≥ {value} {unit}
      </div>
      <div className="ties-slider__hist" aria-hidden="true" style={{ height: 56 }}>
        <div
          className={cx("ties-slider__window", error && "ties-slider__window--full")}
          style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }}
        />
        <span
          style={{
            position: "absolute",
            top: -26,
            right: 0,
            font: "400 11px/14px var(--font-mono)",
            color: error ? "var(--danger-ink)" : "var(--ink-muted)",
            whiteSpace: "nowrap",
          }}
        >
          ±{win} {unit}: {fmtEth(used, 1)}
          {capacityMax ? ` / ${fmtEth(capacityMax, 1)}` : ""} ETH
        </span>
        {histogram.map((b, i) => {
          const near = Math.abs(b.x - value) <= win;
          return (
            <div
              key={i}
              className={cx(
                "ties-slider__bar",
                near ? (error ? "ties-fill-danger" : "ties-fill-info") : "ties-fill-free",
              )}
              style={{
                left: `calc(${pct(b.x)}% - 3px)`,
                width: 6,
                height: `${Math.max(3, (50 * b.v) / hmax)}px`,
              }}
            />
          );
        })}
      </div>
      <div
        className="ties-slider__track"
        onPointerDown={(e) => {
          const rail = e.currentTarget;
          pointer(e.clientX, rail);
          rail.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => pointer(ev.clientX, rail);
          const up = () => {
            rail.removeEventListener("pointermove", move);
            rail.removeEventListener("pointerup", up);
          };
          rail.addEventListener("pointermove", move);
          rail.addEventListener("pointerup", up);
        }}
      >
        <div className="ties-slider__rail" />
        <div
          className="ties-slider__thumb"
          role="slider"
          tabIndex={0}
          aria-label="Trigger threshold"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={`pays if ${metric} ≥ ${value} ${unit}`}
          onKeyDown={onKey}
          style={{ left: `${pct(value)}%` }}
        />
      </div>
      <div className="ties-slider__ticks" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${pct(t)}%` }}>
            {t + (t === max ? ` ${unit}` : "")}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface CapacityMeterProps {
  used: number;
  max: number;
  label?: string;
  note?: string;
  style?: CSSProperties;
}

export function CapacityMeter({ used, max, label, note, style }: CapacityMeterProps) {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  const full = used >= max;
  const text = label ?? "Capacity near this threshold";
  return (
    <div style={style}>
      <div className="ties-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <span className="ties-label">{text}</span>
        <span
          className="ties-mono"
          style={{ fontSize: 12, color: full ? "var(--danger-ink)" : "var(--ink)" }}
        >
          {fmtEth(used, 2)} / {fmtEth(max, 2)} ETH
        </span>
      </div>
      <div
        className="ties-meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={used}
        aria-label={text}
      >
        <i
          className={full ? "ties-fill-danger" : ratio > 0.8 ? "ties-fill-held" : "ties-fill-info"}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      {note ? (
        <div className="ties-field__hint" style={{ marginTop: 6 }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------- IntervalBar

export interface IntervalBarProps {
  min: number;
  max: number;
  threshold: number;
  L?: number;
  U?: number;
  width?: number;
}

/** Inline "your threshold vs the evidence interval". */
export function IntervalBar({ min, max, threshold, L, U, width = 140 }: IntervalBarProps) {
  const x = (v: number) => Math.max(0, Math.min(width, ((v - min) / (max - min)) * width));
  const has = L != null && U != null;
  const state = !has ? "none" : threshold <= L ? "pay" : threshold > U ? "nopay" : "held";
  const colour = {
    pay: "var(--pay)",
    nopay: "var(--nopay-ink)",
    held: "var(--held-ink)",
    none: "var(--ink-muted)",
  }[state];
  return (
    <svg
      width={width}
      height={18}
      viewBox={`0 0 ${width} 18`}
      role="img"
      aria-label={
        has
          ? `Threshold ${threshold} against interval [${L}, ${U}]`
          : `Threshold ${threshold}, no interval yet`
      }
    >
      <rect x={0} y={8} width={width} height={2} rx={1} style={{ fill: "var(--line)" }} />
      {has ? (
        <rect
          x={x(L)}
          y={3}
          width={Math.max(2, x(U) - x(L))}
          height={12}
          rx={2}
          style={{ fill: "var(--interval)", stroke: "var(--held-ink)", strokeWidth: 1 }}
        />
      ) : null}
      <path d={`M${x(threshold)} 1v16`} style={{ stroke: colour, strokeWidth: 2.5 }} />
      {state === "pay" ? (
        <circle cx={x(threshold)} cy={9} r={3.5} style={{ fill: "var(--pay)" }} />
      ) : null}
    </svg>
  );
}

// ----------------------------------------------------------------------- IntervalChart

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const m = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / m;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * m;
}

export type ChartState = "live" | "awaiting" | "insufficient" | "disputed" | "settled";
export type BucketState = "pay" | "nopay" | "held";

/**
 * Settlement of one display bar. Each bar covers `size` one-unit buckets starting at `x`; bucket
 * b pays when its threshold b <= L and does not pay when b > U, so a bar settles only when all of
 * its buckets agree (spec 3.6).
 */
export function bucketState(
  x: number,
  size: number,
  L: number | null | undefined,
  U: number | null | undefined,
  state: ChartState,
): BucketState {
  if (state === "insufficient" || state === "disputed" || state === "awaiting") return "held";
  if (L == null || U == null) return "held";
  if (x + size - 1 <= L) return "pay";
  if (x > U) return "nopay";
  return "held";
}

export interface ChartBucket {
  x: number;
  amount: number;
  mine?: boolean;
}

export interface IntervalChartProps {
  domain: [number, number];
  full?: [number, number];
  buckets: ChartBucket[];
  bucketSize?: number;
  L?: number | null;
  U?: number | null;
  V?: number | null;
  /** Earlier rounds' intervals, drawn as dashed brackets: [lo, hi, label]. */
  prev?: [number, number, string?][];
  unit?: "min" | "mm";
  axisLabel?: string;
  state?: ChartState;
  width?: number;
  height?: number;
  overview?: boolean;
  tableToggle?: boolean;
  showTable?: boolean;
  xStep?: number;
  style?: CSSProperties;
}

/** The hero chart: collateral per bucket, the [L, U] band and the consensus marker. */
export function IntervalChart({
  domain,
  full = [0, 720],
  buckets,
  bucketSize = 1,
  L,
  U,
  V,
  prev = [],
  unit = "min",
  axisLabel,
  state = "live",
  width: W = 960,
  height: H = 320,
  overview = true,
  tableToggle = true,
  showTable = false,
  xStep,
  style,
}: IntervalChartProps) {
  const uid = useId().replace(/:/g, "");
  const hatch = `hatch-${uid}`;
  const dots = `dots-${uid}`;
  const [table, setTable] = useState(showTable);
  const m = { l: 56, r: 20, t: 58, b: overview ? 84 : 36 };
  const [d0, d1] = domain;
  const bs = bucketSize;
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const X = (v: number) => m.l + ((v - d0) / (d1 - d0)) * pw;
  const maxA = Math.max(1, ...buckets.map((b) => b.amount));
  const yStep = niceStep(maxA * 1.3, 4);
  const yMax = Math.ceil((maxA * 1.3) / yStep) * yStep;
  const Y = (a: number) => m.t + ph - (a / yMax) * ph;
  const xs = xStep ?? niceStep(d1 - d0, 9);
  const xt: number[] = [];
  for (let t = Math.ceil(d0 / xs) * xs; t <= d1 + 1e-9; t += xs) xt.push(t);
  const yt: number[] = [];
  for (let u = 0; u <= yMax + 1e-9; u += yStep) yt.push(u);
  const hasIv = L != null && U != null && state !== "awaiting";
  const bad = state === "disputed";
  const fillFor: Record<BucketState, string> = {
    pay: "var(--pay)",
    held: `url(#${hatch})`,
    nopay: `url(#${dots})`,
  };
  const strokeFor: Record<BucketState, string> = {
    pay: "var(--pay-ink)",
    held: "var(--held-ink)",
    nopay: "var(--nopay-ink)",
  };
  const bw = Math.max(4, (bs / (d1 - d0)) * pw - 3);
  const OX = (v: number) => m.l + ((v - full[0]) / (full[1] - full[0])) * pw;
  const oy = H - 30;
  const oh = 18;
  const stateOf = (b: ChartBucket) => bucketState(b.x, bs, L, U, state);
  const summary =
    `Collateral by threshold bucket. ` +
    (hasIv ? `Evidence interval ${L} to ${U} ${unit}, consensus ${V}. ` : "No interval yet. ") +
    buckets.map((b) => `${b.x} ${unit}: ${b.amount} ETH ${stateOf(b)}`).join("; ");

  return (
    <div className="ties-ichart" style={style}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={summary}
        style={{ display: "block", fontFamily: "var(--font-mono)" }}
      >
        <defs>
          <pattern
            id={hatch}
            width={6}
            height={6}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width={6} height={6} style={{ fill: "var(--held)" }} />
            <rect width={2} height={6} style={{ fill: "var(--held-wash)" }} />
          </pattern>
          <pattern id={dots} width={5} height={5} patternUnits="userSpaceOnUse">
            <rect width={5} height={5} style={{ fill: "var(--nopay)" }} />
            <circle cx={2.5} cy={2.5} r={0.9} style={{ fill: "var(--nopay-ink)" }} />
          </pattern>
        </defs>
        <rect x={m.l} y={m.t} width={pw} height={ph} style={{ fill: "var(--surface-2)" }} />
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={m.l} x2={m.l + pw} y1={Y(v)} y2={Y(v)} style={{ stroke: "var(--grid)" }} />
            <text
              x={m.l - 8}
              y={Y(v) + 4}
              textAnchor="end"
              style={{ fill: "var(--ink-subtle)", fontSize: 11 }}
            >
              {v.toFixed(yStep < 1 ? 1 : 0)}
            </text>
          </g>
        ))}
        <text
          x={12}
          y={m.t - 40}
          style={{
            fill: "var(--ink-muted)",
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            letterSpacing: ".08em",
          }}
        >
          ETH LOCKED
        </text>
        {hasIv ? (
          <g>
            <rect
              x={Math.max(m.l, X(L))}
              y={m.t - 22}
              width={Math.max(2, Math.min(m.l + pw, X(U)) - Math.max(m.l, X(L)))}
              height={ph + 18}
              style={{ fill: bad ? "var(--danger-wash)" : "var(--interval)" }}
            />
            {[L, U].map((edge, i) => (
              <line
                key={i}
                x1={X(edge)}
                x2={X(edge)}
                y1={m.t - 22}
                y2={m.t + ph}
                style={{
                  stroke: bad ? "var(--danger)" : "var(--held-ink)",
                  strokeWidth: 1.5,
                  strokeDasharray: "4 3",
                }}
              />
            ))}
            <text
              x={X(L) - 6}
              y={m.t - 40}
              textAnchor="end"
              style={{
                fill: bad ? "var(--danger-ink)" : "var(--held-ink)",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              L {Number(L).toFixed(1)}
            </text>
            <text
              x={X(U) + 6}
              y={m.t - 40}
              style={{
                fill: bad ? "var(--danger-ink)" : "var(--held-ink)",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              U {Number(U).toFixed(1)}
            </text>
          </g>
        ) : null}
        {prev.map((iv, i) => {
          const y = m.t + 14 + i * 14;
          return (
            <g key={`pv${i}`} opacity={0.9}>
              <path
                d={`M${X(iv[0])} ${y + 4}v-6H${X(iv[1])}v6`}
                style={{
                  fill: "none",
                  stroke: "var(--ink-subtle)",
                  strokeWidth: 1,
                  strokeDasharray: "2 2",
                }}
              />
              <text
                x={X(iv[0]) - 5}
                y={y + 3}
                textAnchor="end"
                style={{ fill: "var(--ink-subtle)", fontSize: 10 }}
              >
                {iv[2] ?? `R${i + 1}`}
              </text>
            </g>
          );
        })}
        {buckets.map((b, i) => {
          const s = stateOf(b);
          const x = X(b.x) + 1.5;
          const y = Y(b.amount);
          const hh = m.t + ph - y;
          return (
            <g key={`b${i}`}>
              <rect
                x={x}
                y={y}
                width={bw}
                height={hh}
                rx={2}
                style={{ fill: fillFor[s], stroke: strokeFor[s], strokeWidth: 1 }}
              />
              {b.mine ? (
                <rect
                  x={x - 3}
                  y={y - 3}
                  width={bw + 6}
                  height={hh + 3}
                  rx={3}
                  style={{ fill: "none", stroke: "var(--mine)", strokeWidth: 2 }}
                />
              ) : null}
              <text
                x={x + bw / 2}
                y={y - (b.mine ? 20 : 6)}
                textAnchor="middle"
                style={{ fill: "var(--ink)", fontSize: 11, fontWeight: 500 }}
              >
                {b.amount.toFixed(1)}
              </text>
              {b.mine ? (
                <g>
                  <rect
                    x={x + bw / 2 - 15}
                    y={y - 16}
                    width={30}
                    height={11}
                    rx={2}
                    style={{ fill: "var(--mine)" }}
                  />
                  <text
                    x={x + bw / 2}
                    y={y - 7.5}
                    textAnchor="middle"
                    style={{
                      fill: "var(--ink-inverse)",
                      fontSize: 8.5,
                      fontWeight: 600,
                      fontFamily: "var(--font-sans)",
                      letterSpacing: ".06em",
                    }}
                  >
                    YOU
                  </text>
                </g>
              ) : null}
              {s === "pay" ? (
                <path
                  d={`M${x + bw / 2 - 3.5} ${m.t + ph - 9}l2.5 2.5 4.5-4.5`}
                  style={{ fill: "none", stroke: "var(--ink-inverse)", strokeWidth: 1.6 }}
                />
              ) : null}
            </g>
          );
        })}
        {hasIv && V != null ? (
          <g>
            <line
              x1={X(V)}
              x2={X(V)}
              y1={m.t - 4}
              y2={m.t + ph}
              style={{ stroke: "var(--ink)", strokeWidth: 2 }}
            />
            <path d={`M${X(V)} ${m.t - 10}l5 5-5 5-5-5z`} style={{ fill: "var(--ink)" }} />
            <rect
              x={X(V) - 30}
              y={m.t - 30}
              width={60}
              height={16}
              rx={3}
              style={{ fill: "var(--ink)" }}
            />
            <text
              x={X(V)}
              y={m.t - 18}
              textAnchor="middle"
              style={{ fill: "var(--ink-inverse)", fontSize: 11, fontWeight: 600 }}
            >
              V {Number(V).toFixed(1)}
            </text>
          </g>
        ) : null}
        <line
          x1={m.l}
          x2={m.l + pw}
          y1={m.t + ph}
          y2={m.t + ph}
          style={{ stroke: "var(--line-strong)" }}
        />
        {xt.map((v) => (
          <g key={`x${v}`}>
            <line
              x1={X(v)}
              x2={X(v)}
              y1={m.t + ph}
              y2={m.t + ph + 4}
              style={{ stroke: "var(--line-strong)" }}
            />
            <text
              x={X(v)}
              y={m.t + ph + 17}
              textAnchor="middle"
              style={{ fill: "var(--ink-muted)", fontSize: 11 }}
            >
              {v}
            </text>
          </g>
        ))}
        <text
          x={m.l + pw}
          y={m.t + ph + 32}
          textAnchor="end"
          style={{ fill: "var(--ink-subtle)", fontSize: 11, fontFamily: "var(--font-sans)" }}
        >
          {`${axisLabel ?? "Trigger threshold"} (${unit}) · bar = ${bs} ${unit}`}
        </text>
        {overview ? (
          <g>
            <rect
              x={m.l}
              y={oy}
              width={pw}
              height={oh}
              rx={2}
              style={{ fill: "var(--surface-2)", stroke: "var(--line)" }}
            />
            {buckets.map((b, i) => (
              <rect
                key={`o${i}`}
                x={OX(b.x)}
                y={oy + oh - (oh - 4) * (b.amount / maxA) - 2}
                width={2}
                height={(oh - 4) * (b.amount / maxA)}
                style={{ fill: "var(--ink-muted)" }}
              />
            ))}
            {hasIv ? (
              <rect
                x={OX(L)}
                y={oy}
                width={Math.max(1.5, OX(U) - OX(L))}
                height={oh}
                style={{ fill: "var(--held)" }}
              />
            ) : null}
            <rect
              x={OX(d0)}
              y={oy - 3}
              width={OX(d1) - OX(d0)}
              height={oh + 6}
              rx={3}
              style={{ fill: "none", stroke: "var(--ink)", strokeWidth: 1.5 }}
            />
            <text
              x={m.l - 8}
              y={oy + 13}
              textAnchor="end"
              style={{ fill: "var(--ink-subtle)", fontSize: 10 }}
            >
              {full[0]}
            </text>
            <text
              x={m.l + pw}
              y={oy - 6}
              textAnchor="end"
              style={{ fill: "var(--ink-subtle)", fontSize: 10, fontFamily: "var(--font-sans)" }}
            >
              {`Full axis ${full[0]}–${full[1]} ${unit}`}
            </text>
          </g>
        ) : null}
      </svg>
      <div className="ties-row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <div className="ties-legend">
          <span>
            <i className="ties-sw ties-fill-pay" />
            Settled pay (thresholds ≤ L)
          </span>
          <span>
            <i className="ties-sw ties-fill-held" />
            Held (L &lt; threshold ≤ U)
          </span>
          <span>
            <i className="ties-sw ties-fill-nopay" />
            Settled no pay (thresholds &gt; U)
          </span>
          <span>
            <i className="ties-sw" style={{ boxShadow: "inset 0 0 0 2px var(--mine)" }} />
            Your policy
          </span>
          <span>
            <i className="ties-sw" style={{ width: 2, background: "var(--ink)" }} />
            Consensus V
          </span>
        </div>
        {tableToggle ? (
          <button
            type="button"
            className="ties-btn ties-btn--ghost ties-btn--sm"
            aria-expanded={table}
            onClick={() => setTable(!table)}
          >
            <Icon name="list" size={14} />
            {table ? "Hide data table" : "View as table"}
          </button>
        ) : null}
      </div>
      {table ? (
        <table className="ties-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Bucket</th>
              <th className="num">Locked</th>
              <th>Settlement</th>
              <th>Yours</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => (
              <tr key={i}>
                <td className="ties-mono">
                  {bs === 1 ? `${b.x} ${unit}` : `${b.x}–${b.x + bs - 1} ${unit}`}
                </td>
                <td className="num">{fmtEth(b.amount)}</td>
                <td>
                  <StatusChip status={stateOf(b) as StatusKey} />
                </td>
                <td>{b.mine ? "Yes" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------- RoundTimeline

export interface TimelineRound {
  n: number;
  sub?: string;
  L?: number | null;
  U?: number | null;
  V?: number | null;
  neff?: number | null;
  status?: StatusKey;
  statusLabel?: string;
  tx?: string;
  note?: string;
}

export interface RoundTimelineProps {
  domain: [number, number];
  ticks?: number[];
  rounds: TimelineRound[];
  intersection?: [number, number];
  network?: Network;
  compact?: boolean;
  style?: CSSProperties;
}

/** Each round's interval narrowing, and the running intersection. */
export function RoundTimeline({
  domain,
  ticks = [],
  rounds,
  intersection,
  network,
  compact,
  style,
}: RoundTimelineProps) {
  const [d0, d1] = domain;
  const pc = (v: number) => Math.min(100, Math.max(0, ((v - d0) / (d1 - d0)) * 100));
  return (
    <div className={cx("ties-tl", compact && "ties-tl--compact")} style={style}>
      {rounds.map((r, i) => {
        const cls =
          r.status === "pending"
            ? "ties-tl__iv--pend"
            : r.status === "disputed"
              ? "ties-tl__iv--bad"
              : "";
        const has = r.L != null && r.U != null;
        return (
          <div key={i} className="ties-tl__row">
            <div>
              <div style={{ fontWeight: 600 }}>Round {r.n}</div>
              <div className="ties-subtle" style={{ fontSize: 12 }}>
                {r.sub ?? ""}
              </div>
            </div>
            <div className="ties-tl__lane">
              {has ? (
                <div
                  className={cx("ties-tl__iv", cls)}
                  style={{ left: `${pc(r.L!)}%`, width: `${pc(r.U!) - pc(r.L!)}%` }}
                />
              ) : (
                <div
                  className="ties-tl__iv ties-tl__iv--pend"
                  style={{ left: "2%", right: "2%" }}
                />
              )}
              {r.V != null ? <div className="ties-tl__v" style={{ left: `${pc(r.V)}%` }} /> : null}
            </div>
            <div style={{ fontSize: 12 }}>
              <div className="ties-mono">
                {has
                  ? `[${r.L!.toFixed(1)}, ${r.U!.toFixed(1)}]` +
                    (r.neff != null ? ` · N_eff ${r.neff.toFixed(1)}` : "")
                  : (r.note ?? "Awaiting reports")}
              </div>
              <div className="ties-row" style={{ gap: 6, marginTop: 2 }}>
                {r.status ? <StatusChip status={r.status} label={r.statusLabel} /> : null}
                {r.tx ? <TxHash hash={r.tx} network={network} /> : null}
              </div>
            </div>
          </div>
        );
      })}
      {intersection ? (
        <div
          className="ties-tl__row"
          style={{ borderTop: "1px solid var(--line)", paddingTop: 8, marginTop: 2 }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>∩ Intersection</div>
            <div className="ties-subtle" style={{ fontSize: 12 }}>
              only ever narrows
            </div>
          </div>
          <div className="ties-tl__lane">
            <div
              className="ties-tl__iv ties-tl__iv--x"
              style={{
                left: `${pc(intersection[0])}%`,
                width: `${pc(intersection[1]) - pc(intersection[0])}%`,
              }}
            />
          </div>
          <div className="ties-mono" style={{ fontSize: 12, fontWeight: 600 }}>
            [{intersection[0].toFixed(1)}, {intersection[1].toFixed(1)}]
          </div>
        </div>
      ) : null}
      <div className="ties-tl__row" aria-hidden="true">
        <div />
        <div
          style={{
            position: "relative",
            height: 14,
            font: "400 10px/14px var(--font-mono)",
            color: "var(--ink-subtle)",
          }}
        >
          {ticks.map((t) => (
            <span
              key={t}
              style={{ position: "absolute", left: `${pc(t)}%`, transform: "translateX(-50%)" }}
            >
              {t}
            </span>
          ))}
        </div>
        <div />
      </div>
    </div>
  );
}
