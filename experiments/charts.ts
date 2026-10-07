/**
 * Renders the experiment figures from experiments/results/summary.json to docs/figures/*.png.
 *   npx ts-node --transpile-only experiments/charts.ts
 */
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const summary = JSON.parse(
  fs.readFileSync(path.join(__dirname, "results", "summary.json"), "utf8"),
);
const outDir = path.join(root, "docs", "figures");
fs.mkdirSync(outDir, { recursive: true });

const COLORS = {
  ties: "#0c7d67",
  single: "#c3342a",
  avg2: "#e2a034",
  median3: "#2a6ade",
  median7: "#7d868f",
};
const NAMES = {
  ties: "TIES",
  single: "Single oracle",
  avg2: "2-report average",
  median3: "2-of-3 median",
  median7: "7-oracle median",
};

interface Series {
  key: keyof typeof COLORS;
  values: (number | null)[];
}

function lineChart(opts: {
  file: string;
  title: string;
  xTitle: string;
  yTitle: string;
  xLabels: string[];
  series: Series[];
  yMax?: number;
  hline?: { value: number; label: string };
  percent?: boolean;
  logY?: boolean;
}) {
  const W = 900;
  const H = 520;
  const m = { l: 90, r: 190, t: 60, b: 80 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const all = opts.series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const yMax = opts.yMax ?? Math.max(...all, opts.hline?.value ?? 0, 1e-9) * 1.1;
  const yMinLog = Math.min(...all.filter((v) => v > 0), yMax) / 2;
  const Y = (v: number) =>
    opts.logY
      ? m.t +
        ph -
        ((Math.log(Math.max(v, yMinLog)) - Math.log(yMinLog)) /
          (Math.log(yMax) - Math.log(yMinLog))) *
          ph
      : m.t + ph - (v / yMax) * ph;
  const X = (i: number) =>
    m.l + (opts.xLabels.length === 1 ? pw / 2 : (i / (opts.xLabels.length - 1)) * pw);
  const fmt = (v: number) =>
    opts.percent
      ? `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`
      : v >= 1e6
        ? `${(v / 1e6).toFixed(1)}M`
        : v >= 1e3
          ? `${(v / 1e3).toFixed(0)}k`
          : v.toFixed(v < 10 ? 1 : 0);
  const ticks = opts.logY
    ? Array.from({ length: 5 }, (_, i) =>
        Math.exp(Math.log(yMinLog) + ((Math.log(yMax) - Math.log(yMinLog)) * i) / 4),
      )
    : Array.from({ length: 6 }, (_, i) => (yMax * i) / 5);
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(
    `<text x="${m.l}" y="32" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#0f161c">${opts.title}</text>`,
  );
  for (const t of ticks) {
    parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(t)}" y2="${Y(t)}" stroke="#e5e8e4"/>`);
    parts.push(
      `<text x="${m.l - 8}" y="${Y(t) + 4}" text-anchor="end" font-family="Arial, sans-serif" font-size="12" fill="#4d5862">${fmt(t)}</text>`,
    );
  }
  opts.xLabels.forEach((l, i) => {
    parts.push(
      `<text x="${X(i)}" y="${m.t + ph + 22}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#4d5862">${l}</text>`,
    );
  });
  parts.push(
    `<line x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="#7d868f"/>`,
  );
  parts.push(
    `<text x="${m.l + pw / 2}" y="${H - 22}" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#0f161c">${opts.xTitle}</text>`,
  );
  parts.push(
    `<text transform="translate(22 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#0f161c">${opts.yTitle}</text>`,
  );
  if (opts.hline) {
    parts.push(
      `<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(opts.hline.value)}" y2="${Y(opts.hline.value)}" stroke="#a12419" stroke-dasharray="6 4"/>`,
    );
    parts.push(
      `<text x="${m.l + pw - 4}" y="${Y(opts.hline.value) - 6}" text-anchor="end" font-family="Arial, sans-serif" font-size="12" fill="#a12419">${opts.hline.label}</text>`,
    );
  }
  opts.series.forEach((s, si) => {
    const pts = s.values.map((v, i) => (v == null ? null : ([X(i), Y(v)] as [number, number])));
    const path = pts
      .filter(Boolean)
      .map((p, i) => `${i === 0 ? "M" : "L"}${p![0]} ${p![1]}`)
      .join(" ");
    parts.push(
      `<path d="${path}" fill="none" stroke="${COLORS[s.key]}" stroke-width="${s.key === "ties" ? 3.5 : 2.2}"${s.key === "ties" ? "" : ' stroke-dasharray="1 0"'}/>`,
    );
    for (const p of pts)
      if (p)
        parts.push(
          `<circle cx="${p[0]}" cy="${p[1]}" r="${s.key === "ties" ? 5 : 3.5}" fill="${COLORS[s.key]}"/>`,
        );
    const ly = m.t + 10 + si * 24;
    parts.push(
      `<line x1="${m.l + pw + 24}" x2="${m.l + pw + 50}" y1="${ly}" y2="${ly}" stroke="${COLORS[s.key]}" stroke-width="3"/>`,
    );
    parts.push(
      `<text x="${m.l + pw + 56}" y="${ly + 4}" font-family="Arial, sans-serif" font-size="12" fill="#0f161c">${NAMES[s.key]}</text>`,
    );
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1800 } }).render().asPng();
  fs.writeFileSync(path.join(outDir, opts.file), png);
  console.log(`wrote docs/figures/${opts.file}`);
}

// 1. Gas vs number of policies.
const gas = summary.gasVsPolicies as {
  n: number;
  tiesFinalizeRound: number;
  baselines: Record<string, number | string>;
}[];
lineChart({
  file: "gas_vs_policies.png",
  title: "Settlement gas against number of policies",
  xTitle: "Policies on the event",
  yTitle: "Gas of the settling transaction",
  xLabels: gas.map((g) => String(g.n)),
  series: [
    { key: "ties", values: gas.map((g) => g.tiesFinalizeRound) },
    ...(["single", "avg2", "median3", "median7"] as const).map((b) => ({
      key: b,
      values: gas.map((g) =>
        typeof g.baselines[b] === "number" ? (g.baselines[b] as number) : null,
      ),
    })),
  ],
  hline: { value: 30_000_000, label: "Block gas limit (30M)" },
});

// 2. Wrong settlements against compromised share.
const comp = summary.sweeps.compromisedSources as Record<string, number>[];
lineChart({
  file: "wrong_vs_compromised.png",
  title: "Wrong settlements against compromised sources",
  xTitle: "Compromised sources among the first three (each +90 min)",
  yTitle: "Policies settled wrongly",
  xLabels: comp.map((c) => String(c.compromisedSources)),
  series: (["ties", "single", "avg2", "median3", "median7"] as const).map((k) => ({
    key: k,
    values: comp.map((c) => c[k]),
  })),
  percent: true,
});

// 3. Oracle calls against u_min.
const um = summary.sweeps.uMin as Record<string, number>[];
lineChart({
  file: "oracle_calls_vs_umin.png",
  title: "Oracle transactions per event against the escalation trigger",
  xTitle: "Escalation trigger u_min (ETH held inside the interval)",
  yTitle: "Oracle transactions per event (commit and reveal count separately)",
  xLabels: um.map((u) => String(u.uMinEth)),
  series: [
    { key: "ties", values: um.map((u) => u.oracleTxsPerEvent) },
    { key: "median7", values: um.map(() => 7) },
  ],
});

// 4. Auto-settled against alpha.
const al = summary.sweeps.alpha as Record<string, number>[];
lineChart({
  file: "auto_vs_alpha.png",
  title: "Policies settled by evidence against the confidence level",
  xTitle: "alpha (smaller means wider intervals)",
  yTitle: "Share of policies",
  xLabels: al.map((a) => String(a.alpha)),
  series: [
    { key: "ties", values: al.map((a) => a.autoRate) },
    { key: "single", values: al.map((a) => a.wrongRate) },
  ],
  percent: true,
});
console.log("(figure 4: green is settled by evidence before any default, red is wrongly settled)");
