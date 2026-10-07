import { useEffect, useState } from "react";
import type { Contract } from "ethers";
import { formatUnits, isAddress, parseUnits } from "ethers";
import {
  Address,
  Banner,
  Button,
  DataTable,
  EmptyState,
  KeyValue,
  PageHeader,
  Panel,
  SegmentedControl,
  StatusChip,
  TextField,
  TxFlow,
} from "../components";
import { useChainClock, useContracts, useNetwork, useTx, useWallet } from "../hooks";
import { CategoryInfo, Params, useCategories } from "../hooks/events";
import { useRoles } from "../hooks/data";
import { useSources } from "../hooks/lookups";
import { toolHashOf } from "../lib/toolhash";

type Kind = "int" | "raw" | "wad" | "text" | "wadList" | "rawList";
const FIELDS: [keyof Params, string, Kind][] = [
  ["unit", "Unit", "text"],
  ["bucketCount", "Bucket count", "int"],
  ["bucketWidth", "Bucket width (milli-units)", "raw"],
  ["maxReportsPerEvent", "Max reports per event", "int"],
  ["kMax", "Max rounds (K_max)", "int"],
  ["kRound", "Max recruits per round", "int"],
  ["commitWindow", "Commit window (s)", "int"],
  ["revealWindow", "Reveal window (s)", "int"],
  ["challengePeriod", "Challenge period (s)", "int"],
  ["s", "Deviation scale s (milli-units)", "raw"],
  ["sigmaFloor", "Sigma floor (milli-units)", "raw"],
  ["delta", "Kernel width δ", "wad"],
  ["dCut", "Outlier cut D", "wad"],
  ["nMin", "Minimum N_eff", "wad"],
  ["rho0", "Prior dependence ρ₀", "wad"],
  ["uMin", "Escalation trigger (ETH)", "wad"],
  ["rMin", "Minimum reputation to recruit", "wad"],
  ["alpha0", "Initial α", "wad"],
  ["beta0", "Initial β", "wad"],
  ["gamma", "Reputation decay γ", "wad"],
  ["mu", "Dependence learning rate μ", "wad"],
  ["eps", "Error tolerance ε", "wad"],
  ["capacityCapPerWindow", "Capacity cap per window (ETH)", "wad"],
  ["eta", "Max share of free liquidity per event η", "wad"],
  ["margin", "Pricing margin", "wad"],
  ["escalationFee", "Escalation fee (ETH)", "wad"],
  ["zByRound", "z by round", "wadList"],
  ["curveTheta", "Exceedance curve: thresholds (milli-units)", "rawList"],
  ["curveProb", "Exceedance curve: probabilities", "wadList"],
];

const show = (v: unknown, kind: Kind): string => {
  if (kind === "wad") return formatUnits(v as bigint, 18);
  if (kind === "wadList") return (v as bigint[]).map((x) => formatUnits(x, 18)).join(", ");
  if (kind === "rawList") return (v as bigint[]).join(", ");
  return String(v);
};
const parse = (t: string, kind: Kind): unknown => {
  if (kind === "text") return t;
  if (kind === "int") return Number(t);
  if (kind === "raw") return BigInt(t);
  if (kind === "wad") return parseUnits(t, 18);
  const parts = t
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return kind === "wadList" ? parts.map((x) => parseUnits(x, 18)) : parts.map((x) => BigInt(x));
};

function ParamsEditor({ info, admin }: { info: CategoryInfo; admin: boolean }) {
  const { getWriteContracts } = useContracts();
  const { info: net } = useNetwork();
  const tx = useTx();
  const initial = Object.fromEntries(FIELDS.map(([k, , kind]) => [k, show(info.params[k], kind)]));
  const [form, setForm] = useState<Record<string, string>>(initial);
  useEffect(() => setForm(initial), [info.version]);
  const changed = FIELDS.filter(([k]) => form[k] !== initial[k]);
  let invalid: string | null = null;
  const next: Record<string, unknown> = {};
  for (const [k, label, kind] of FIELDS) {
    try {
      next[k] = parse(form[k], kind);
    } catch {
      invalid = `Invalid value for ${label}`;
    }
  }
  return (
    <Panel
      title={`${info.name} · version ${info.version}`}
      icon="sliders"
      badge={
        <span className="ties-subtle" style={{ fontSize: 12 }}>
          Applies to events created after a change; existing events keep their snapshot.
        </span>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 12,
        }}
      >
        {FIELDS.map(([k, label]) => (
          <TextField
            key={k}
            label={label}
            value={form[k]}
            readOnly={!admin}
            mono
            onChange={(v) => setForm((f) => ({ ...f, [k]: v }))}
            hint={form[k] !== initial[k] ? `was ${initial[k]}` : undefined}
            style={
              form[k] !== initial[k]
                ? { outline: "2px solid var(--held)", borderRadius: 4 }
                : undefined
            }
          />
        ))}
      </div>
      {admin ? (
        <div style={{ marginTop: 12 }}>
          {changed.length ? (
            <p className="ties-muted">Changed: {changed.map(([, l]) => l).join(", ")}</p>
          ) : null}
          {invalid ? <div className="ties-field__error">{invalid}</div> : null}
          <Button
            disabled={!changed.length || invalid !== null}
            loading={tx.state === "awaiting" || tx.state === "pending"}
            onClick={() =>
              void tx.run(`Save ${info.name} parameters`, async () =>
                ((await getWriteContracts()).registry as Contract).setCategory(info.category, next),
              )
            }
          >
            Save as a new version
          </Button>
        </div>
      ) : null}
      {tx.state !== "idle" ? (
        <div style={{ marginTop: 12 }}>
          <TxFlow
            state={tx.state}
            hash={tx.data.hash}
            block={tx.data.block}
            gas={tx.data.gas}
            reason={tx.data.reason}
            raw={tx.data.raw}
            network={net.key}
            action="TIESRegistry.setCategory"
          >
            <Button size="sm" variant="ghost" onClick={tx.reset}>
              Dismiss
            </Button>
          </TxFlow>
        </div>
      ) : null}
    </Panel>
  );
}

function TxPanel({ tx, action }: { tx: ReturnType<typeof useTx>; action: string }) {
  const { info } = useNetwork();
  if (tx.state === "idle") return null;
  return (
    <div style={{ marginTop: 12 }}>
      <TxFlow
        state={tx.state}
        hash={tx.data.hash}
        block={tx.data.block}
        gas={tx.data.gas}
        reason={tx.data.reason}
        raw={tx.data.raw}
        network={info.key}
        action={action}
      >
        <Button size="sm" variant="ghost" onClick={tx.reset}>
          Dismiss
        </Button>
      </TxFlow>
    </div>
  );
}

function SourcesPanel({ admin }: { admin: boolean }) {
  const { getWriteContracts } = useContracts();
  const sources = useSources();
  const tx = useTx();
  const [signer, setSigner] = useState("");
  const [category, setCategory] = useState("0");
  const [name, setName] = useState("");
  const [tool, setTool] = useState("get_flight_delay");
  const add = () =>
    void tx.run(`Register source ${name}`, async () =>
      ((await getWriteContracts()).registry as Contract).registerSource(
        signer,
        Number(category),
        name,
        [toolHashOf(tool)],
      ),
    );
  return (
    <Panel title="Sources and tool allowlist" icon="server">
      <DataTable
        caption="Sources"
        rows={[...sources.values()]}
        empty={<EmptyState title="No sources registered" />}
        columns={[
          { title: "Id", num: true, render: (r) => `S${r.id}` },
          { title: "Name", key: "name" },
          { title: "Category", render: (r) => (r.category === 0 ? "Flight" : "Rain") },
          { title: "Signer", render: (r) => <Address value={r.signer} /> },
          {
            title: "Status",
            render: (r) => (
              <StatusChip
                status={r.active ? "running" : "stopped"}
                label={r.active ? "Active" : "Inactive"}
              />
            ),
          },
          {
            title: "",
            render: (r) =>
              admin ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void tx.run(`${r.active ? "Deactivate" : "Activate"} S${r.id}`, async () =>
                      ((await getWriteContracts()).registry as Contract).setSourceActive(
                        r.id,
                        !r.active,
                      ),
                    )
                  }
                >
                  {r.active ? "Deactivate" : "Activate"}
                </Button>
              ) : null,
          },
        ]}
      />
      {admin ? (
        <div style={{ marginTop: 16 }}>
          <div className="ties-label">Register a source</div>
          <div className="ties-row" style={{ alignItems: "flex-end", marginTop: 8 }}>
            <TextField
              label="Signer address"
              mono
              value={signer}
              onChange={setSigner}
              error={signer && !isAddress(signer) ? "Not an address" : undefined}
              style={{ width: 360 }}
            />
            <TextField label="Name" value={name} onChange={setName} />
            <SegmentedControl
              label="Category"
              value={category}
              onChange={(v) => {
                setCategory(v);
                setTool(v === "0" ? "get_flight_delay" : "get_rainfall_24h");
              }}
              options={[
                { value: "0", label: "Flight" },
                { value: "1", label: "Rain" },
              ]}
            />
            <Button disabled={!isAddress(signer) || !name} onClick={add}>
              Register
            </Button>
          </div>
          <div className="ties-field__hint">
            Allowed tool hash: {tool} →{" "}
            <span className="ties-mono">{toolHashOf(tool).slice(0, 18)}…</span>
          </div>
        </div>
      ) : null}
      <TxPanel tx={tx} action="TIESRegistry" />
    </Panel>
  );
}

interface OracleRow {
  address: string;
  category: number;
  sourceId: number;
  primary: boolean;
  active: boolean;
}

function OraclesPanel({ admin }: { admin: boolean }) {
  const { read, getWriteContracts } = useContracts();
  const { block } = useNetwork();
  const tx = useTx();
  const sources = useSources();
  const [rows, setRows] = useState<OracleRow[]>([]);
  const [address, setAddress] = useState("");
  const [category, setCategory] = useState("0");
  const [sourceId, setSourceId] = useState("1");
  useEffect(() => {
    if (!read) return;
    let alive = true;
    void (async () => {
      const out: OracleRow[] = [];
      for (const c of [0, 1]) {
        const n = Number(await read.registry.oracleCount(c));
        for (let i = 0; i < n; i++) {
          const a = (await read.registry.oracleAt(c, i)) as string;
          const o = await read.registry.getOracle(a, c);
          out.push({
            address: a,
            category: c,
            sourceId: Number(o.sourceId),
            primary: o.primary,
            active: o.active,
          });
        }
      }
      if (alive) setRows(out);
    })();
    return () => {
      alive = false;
    };
  }, [read, block?.number]);
  const update = (r: OracleRow, primary: boolean, active: boolean) =>
    void tx.run(`Update oracle ${r.address.slice(0, 8)}`, async () =>
      ((await getWriteContracts()).registry as Contract).updateOracle(
        r.address,
        r.category,
        r.sourceId,
        primary,
        active,
      ),
    );
  return (
    <Panel title="Oracle allowlist" icon="user">
      <DataTable
        caption="Oracles"
        rows={rows}
        empty={<EmptyState title="No oracles registered" />}
        columns={[
          { title: "Oracle", render: (r) => <Address value={r.address} /> },
          { title: "Category", render: (r) => (r.category === 0 ? "Flight" : "Rain") },
          { title: "Source", render: (r) => sources.get(r.sourceId)?.name ?? `S${r.sourceId}` },
          { title: "Round 1", render: (r) => (r.primary ? "Committee" : "Recruited") },
          {
            title: "Status",
            render: (r) => (
              <StatusChip
                status={r.active ? "running" : "stopped"}
                label={r.active ? "Active" : "Inactive"}
              />
            ),
          },
          {
            title: "",
            render: (r) =>
              admin ? (
                <span className="ties-row">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => update(r, !r.primary, r.active)}
                  >
                    {r.primary ? "Remove from committee" : "Add to committee"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => update(r, r.primary, !r.active)}>
                    {r.active ? "Disable" : "Enable"}
                  </Button>
                </span>
              ) : null,
          },
        ]}
      />
      {admin ? (
        <div className="ties-row" style={{ alignItems: "flex-end", marginTop: 16 }}>
          <TextField
            label="Oracle address"
            mono
            value={address}
            onChange={setAddress}
            style={{ width: 360 }}
            error={address && !isAddress(address) ? "Not an address" : undefined}
          />
          <SegmentedControl
            label="Category"
            value={category}
            onChange={setCategory}
            options={[
              { value: "0", label: "Flight" },
              { value: "1", label: "Rain" },
            ]}
          />
          <TextField
            label="Source id"
            mono
            value={sourceId}
            onChange={setSourceId}
            style={{ width: 100 }}
          />
          <Button
            disabled={!isAddress(address)}
            onClick={() =>
              void tx.run("Register oracle", async () =>
                ((await getWriteContracts()).registry as Contract).registerOracle(
                  address,
                  Number(category),
                  Number(sourceId),
                  false,
                ),
              )
            }
          >
            Register
          </Button>
        </div>
      ) : null}
      <TxPanel tx={tx} action="TIESRegistry" />
    </Panel>
  );
}

function CreateEvent() {
  const { getWriteContracts } = useContracts();
  const now = useChainClock();
  const tx = useTx();
  const [category, setCategory] = useState("0");
  const [label, setLabel] = useState("AI 101 DEL-BOM 2026-10-12");
  const [key, setKey] = useState("AI101|2026-10-12");
  const [cutoff, setCutoff] = useState("60");
  const [obs, setObs] = useState("120");
  return (
    <Panel title="Create event" icon="plus">
      <div className="ties-row" style={{ alignItems: "flex-end" }}>
        <SegmentedControl
          label="Category"
          value={category}
          onChange={(v) => {
            setCategory(v);
            setLabel(v === "0" ? "AI 101 DEL-BOM 2026-10-12" : "Chennai 24h rainfall 2025-10-22");
            setKey(v === "0" ? "AI101|2026-10-12" : "13.08,80.27|2025-10-22");
          }}
          options={[
            { value: "0", label: "Flight" },
            { value: "1", label: "Rain" },
          ]}
        />
        <TextField label="Label" value={label} onChange={setLabel} style={{ width: 280 }} />
        <TextField
          label="Observation key"
          mono
          value={key}
          onChange={setKey}
          hint={category === "0" ? "flight|date" : "lat,lon|date"}
          style={{ width: 240 }}
        />
        <TextField
          label="Binding closes in"
          mono
          value={cutoff}
          onChange={setCutoff}
          suffix="min"
          style={{ width: 140 }}
        />
        <TextField
          label="Rounds open after"
          mono
          value={obs}
          onChange={setObs}
          suffix="min"
          style={{ width: 140 }}
        />
        <Button
          disabled={!label || !key}
          onClick={() =>
            void tx.run("Create event", async () =>
              ((await getWriteContracts()).book as Contract).createEvent(
                Number(category),
                label,
                key,
                now + Number(cutoff) * 60,
                now + Number(obs) * 60,
              ),
            )
          }
        >
          Create event
        </Button>
      </div>
      <TxPanel tx={tx} action="PolicyBook.createEvent" />
    </Panel>
  );
}

/** Admin: parameters, sources, oracles and event creation. Everyone else sees a read-only view. */
export function Admin() {
  const cats = useCategories();
  const { admin } = useRoles();
  const { account } = useWallet();
  const [tab, setTab] = useState("params");
  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Registry & parameters"
        subtitle={
          admin ? "You hold the admin role." : "Read-only: only the admin account can change these."
        }
      />
      {!account ? (
        <Banner tone="info" title="Connect a wallet to edit">
          Anyone can read the registry; editing needs the admin account.
        </Banner>
      ) : null}
      <SegmentedControl
        label="Section"
        value={tab}
        onChange={setTab}
        options={[
          { value: "params", label: "Parameters" },
          { value: "sources", label: "Sources" },
          { value: "oracles", label: "Oracles" },
          { value: "event", label: "Create event" },
        ]}
      />
      {tab === "params"
        ? cats.map((c) => (
            <ParamsEditor key={`${c.category}-${c.version}`} info={c} admin={admin} />
          ))
        : null}
      {tab === "sources" ? <SourcesPanel admin={admin} /> : null}
      {tab === "oracles" ? <OraclesPanel admin={admin} /> : null}
      {tab === "event" ? (
        admin ? (
          <CreateEvent />
        ) : (
          <EmptyState title="Only the admin can create events" />
        )
      ) : null}
      <KeyValue items={[]} />
    </>
  );
}
