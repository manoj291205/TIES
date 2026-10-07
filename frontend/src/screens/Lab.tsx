import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  IntervalChart,
  PageHeader,
  Panel,
  SegmentedControl,
  StatusChip,
  TxHash,
} from "../components";
import { useContracts, useNetwork } from "../hooks";
import { useEventState } from "../hooks/data";
import { ExperimentSummary, demoGet, demoStream, loadExperiments } from "../lib/demo";
import { fmtInt, weiToEth } from "../lib/format";

interface Scenario {
  name: string;
  title: string;
  description: string;
  category: string;
}
interface TxRow {
  hash: string;
  role: string;
  contract: string;
  method: string;
  status: "mined" | "reverted";
  gasUsed: string;
  block: number;
}
interface RoundRow {
  round: number;
  outcome: string;
  value: number;
  nEff: number;
  lower: number;
  upper: number;
  held: string;
}
interface Result {
  ok: boolean;
  status: string;
  wrongSettlements: number;
  txCount: number;
  gasTotal: string;
  checks: { label: string; pass: boolean; detail: string }[];
  policies: {
    id: number;
    bucket: number;
    payout: string;
    decision: string;
    correct: boolean | null;
  }[];
}
interface RunHistory {
  at: string;
  scenario: string;
  eventId: number;
  ok: boolean;
  status: string;
  txCount: number;
  gasTotal: string;
  wrong: number;
  rounds: number;
}

/** The chart of the event a scenario is playing, updated from contract state. */
function LiveChart({ eventId, unit }: { eventId: number; unit: string }) {
  const { read } = useContracts();
  const { view } = useEventState(eventId);
  const [amounts, setAmounts] = useState<bigint[]>([]);
  useEffect(() => {
    if (!read || !view) return;
    read.book
      .bucketsInRange(eventId, 0, view.bucketCount - 1)
      .then((a: bigint[]) => setAmounts([...a]))
      .catch(() => undefined);
  }, [read, view?.bucketCount, view?.payCursor, view?.noPayCursor, eventId]);
  if (!view) return null;
  const buckets = amounts.map((a, x) => ({ x, amount: weiToEth(a) })).filter((b) => b.amount > 0);
  if (!buckets.length) return <p className="ties-muted">Waiting for policies…</p>;
  const lo = Math.max(0, Math.min(...buckets.map((b) => b.x)) - 15);
  const hi = Math.max(...buckets.map((b) => b.x)) + 15;
  const has = view.hasInterval;
  return (
    <IntervalChart
      domain={[lo, hi]}
      buckets={buckets}
      unit={unit as "min" | "mm"}
      L={has ? Number(view.lower) / 1000 : null}
      U={has && view.upper < 10n ** 30n ? Number(view.upper) / 1000 : null}
      V={has ? Number(view.vLast) / 1000 : null}
      state={view.status === "DISPUTED" ? "disputed" : has ? "live" : "awaiting"}
      payCursor={view.round ? view.payCursor : undefined}
      noPayCursor={view.round ? view.noPayCursor : undefined}
      overview={false}
      tableToggle={false}
      height={260}
    />
  );
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Live demo lab: run a scenario with real transactions and compare with the baselines. */
export function Lab() {
  const { info } = useNetwork();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [name, setName] = useState("compromised-feed");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<TxRow[]>([]);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [event, setEvent] = useState<{ eventId: number; unit: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exp, setExp] = useState<ExperimentSummary | null>(null);
  const [history, setHistory] = useState<RunHistory[]>([]);
  const [expLines, setExpLines] = useState<string[]>([]);
  const [expRunning, setExpRunning] = useState(false);

  const refresh = () => {
    void loadExperiments().then(setExp);
    demoGet<RunHistory[]>("/runs")
      .then(setHistory)
      .catch(() => undefined);
  };
  useEffect(() => {
    demoGet<Scenario[]>("/scenarios")
      .then(setScenarios)
      .catch((e) =>
        setError(`The demo server is not reachable: ${e instanceof Error ? e.message : e}`),
      );
    refresh();
  }, []);

  if (info.key !== "local")
    return (
      <EmptyState title="Local network only" body="The demo lab drives the local Hardhat stack." />
    );

  const run = async () => {
    setRunning(true);
    setSteps([]);
    setRounds([]);
    setLogLines([]);
    setEvent(null);
    setResult(null);
    setError(null);
    try {
      await demoStream(`/scenarios/${name}/run`, (type, data) => {
        if (type === "log") setLogLines((l) => [...l, String(data.message)]);
        else if (type === "tx") setSteps((s) => [...s, data.tx as TxRow]);
        else if (type === "round")
          setRounds((r) => [
            ...r.filter((x) => x.round !== (data.round as RoundRow).round),
            data.round as RoundRow,
          ]);
        else if (type === "event")
          setEvent({ eventId: Number(data.eventId), unit: String(data.unit) });
        else if (type === "result") setResult(data.result as Result);
        else if (type === "error" || type === "failed") setError(String(data.message));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      refresh();
    }
  };

  const runExperiments = async () => {
    setExpRunning(true);
    setExpLines([]);
    try {
      await demoStream("/experiments/run", (type, data) => {
        if (type === "progress") setExpLines((l) => [...l.slice(-12), String(data.line)]);
      });
    } finally {
      setExpRunning(false);
      refresh();
    }
  };

  const current = scenarios.find((s) => s.name === name);
  const cmp = exp?.scenarios[name];
  const systems = cmp
    ? [
        {
          system: "TIES",
          wrong: cmp.ties.wrongRate,
          settled: cmp.ties.autoRate + cmp.ties.defaultRate,
          txs: cmp.ties.oracleTxsPerEvent,
          gas: cmp.ties.settleGasPerEvent,
        },
        ...Object.entries(cmp.baselines).map(([k, b]) => ({
          system:
            {
              single: "Single oracle",
              avg2: "2-report average",
              median3: "2-of-3 median",
              median7: "7-oracle median",
            }[k] ?? k,
          wrong: b.wrongRate,
          settled: b.settledRate,
          txs: b.oracleTxsPerEvent,
          gas: b.settleGasPerEvent,
        })),
      ]
    : [];

  return (
    <>
      <PageHeader
        eyebrow="Demo"
        title="Live demo lab"
        subtitle="A real run: oracle nodes sign reports from separate accounts and every step is a mined transaction."
      />
      {error ? (
        <Banner tone="danger" title="Problem">
          {error}
        </Banner>
      ) : null}
      <Panel
        title="Scenario"
        icon="beaker"
        actions={
          <Button icon="play" loading={running} onClick={() => void run()}>
            Run
          </Button>
        }
      >
        <SegmentedControl
          label="Scenario"
          value={name}
          onChange={setName}
          options={scenarios
            .filter((s) => s.category === "FLIGHT")
            .map((s) => ({ value: s.name, label: s.title }))}
        />
        {current ? (
          <p className="ties-muted" style={{ marginBottom: 0 }}>
            {current.description}
          </p>
        ) : null}
      </Panel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
          gap: 24,
          alignItems: "start",
        }}
      >
        <Panel
          title="Steps"
          icon="list"
          badge={
            <span className="ties-subtle" style={{ fontSize: 12 }}>
              {steps.length} transactions
            </span>
          }
        >
          {logLines.length ? (
            <p className="ties-subtle" style={{ marginTop: 0 }}>
              {logLines[logLines.length - 1]}
            </p>
          ) : null}
          <div style={{ maxHeight: 360, overflow: "auto" }}>
            <DataTable<TxRow>
              caption="Transactions"
              rows={steps.slice(-40)}
              empty={<EmptyState title="Nothing yet" body="Press Run." />}
              columns={[
                { title: "Block", num: true, render: (r) => `#${r.block}` },
                { title: "From", key: "role" },
                { title: "Call", render: (r) => `${r.contract}.${r.method}` },
                { title: "Gas", num: true, render: (r) => fmtInt(Number(r.gasUsed)) },
                {
                  title: "Status",
                  render: (r) => (
                    <StatusChip status={r.status === "mined" ? "confirmed" : "reverted"} />
                  ),
                },
                { title: "Tx", render: (r) => <TxHash hash={r.hash} network="local" /> },
              ]}
            />
          </div>
        </Panel>
        <div className="ties-stack">
          <Panel title="Settlement" icon="target">
            {event ? (
              <LiveChart eventId={event.eventId} unit={event.unit} />
            ) : (
              <p className="ties-muted">The chart appears once the scenario creates its event.</p>
            )}
            {rounds.map((r) => (
              <div key={r.round} className="ties-mono" style={{ fontSize: 12 }}>
                round {r.round}: {r.outcome} · V {r.value.toFixed(1)} · N_eff {r.nEff.toFixed(2)} ·
                [{r.lower.toFixed(1)}, {Number.isFinite(r.upper) ? r.upper.toFixed(1) : "∞"}]
              </div>
            ))}
            {event ? (
              <p>
                <a className="ties-link" href={`#/explorer/${event.eventId}`}>
                  Open in the settlement explorer
                </a>
              </p>
            ) : null}
          </Panel>
          {result ? (
            <Panel
              title="Result"
              icon="check"
              badge={
                <StatusChip
                  status={result.ok ? "pay" : "held"}
                  label={result.ok ? "As expected" : "Not as expected"}
                />
              }
            >
              <p style={{ marginTop: 0 }}>
                Event ended {result.status}; {result.wrongSettlements} wrong settlements;{" "}
                {result.txCount} transactions, {fmtInt(Number(result.gasTotal))} gas.
              </p>
              {result.checks.map((c) => (
                <div key={c.label}>
                  <StatusChip
                    status={c.pass ? "pay" : "reverted"}
                    label={c.pass ? "Pass" : "Fail"}
                  />{" "}
                  {c.label} <span className="ties-subtle">({c.detail})</span>
                </div>
              ))}
            </Panel>
          ) : null}
        </div>
      </div>

      <Panel
        title="TIES against the baselines"
        icon="scale"
        badge={
          exp ? (
            <span className="ties-subtle" style={{ fontSize: 12 }}>
              {exp.config.eventsPerScenario} events × {exp.config.policiesPerEvent} policies, real
              receipts, {new Date(exp.generatedAt).toLocaleString()}
            </span>
          ) : null
        }
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            loading={expRunning}
            onClick={() => void runExperiments()}
          >
            Run experiments
          </Button>
        }
      >
        {expRunning || expLines.length ? (
          <pre
            className="ties-mono"
            style={{ fontSize: 11, maxHeight: 140, overflow: "auto", margin: 0 }}
          >
            {expLines.join("\n")}
          </pre>
        ) : null}
        {!exp ? (
          <EmptyState
            title="No experiment results yet"
            body="Press Run experiments (it takes a while) or run npx hardhat run experiments/run.ts."
          />
        ) : !cmp ? (
          <p className="ties-muted">This scenario is not part of the experiment set.</p>
        ) : (
          <DataTable
            caption="Comparison"
            rows={systems}
            columns={[
              { title: "System", key: "system" },
              { title: "Wrong settlements", num: true, render: (r) => pct(r.wrong) },
              { title: "Settled without the admin", num: true, render: (r) => pct(r.settled) },
              { title: "Oracle txs / event", num: true, render: (r) => r.txs.toFixed(2) },
              { title: "Settle gas / event", num: true, render: (r) => fmtInt(Math.round(r.gas)) },
            ]}
          />
        )}
        {exp ? (
          <>
            <div className="ties-label" style={{ marginTop: 16 }}>
              Settling gas against policies on the event
            </div>
            <DataTable
              caption="Gas against policies"
              rows={exp.gasVsPolicies}
              columns={[
                { title: "Policies", num: true, key: "n" },
                {
                  title: "TIES finalizeRound",
                  num: true,
                  render: (r) => fmtInt(r.tiesFinalizeRound),
                },
                ...(["single", "avg2", "median3", "median7"] as const).map((b) => ({
                  title: b,
                  num: true,
                  render: (r: ExperimentSummary["gasVsPolicies"][number]) =>
                    typeof r.baselines[b] === "number"
                      ? fmtInt(r.baselines[b] as number)
                      : String(r.baselines[b]),
                })),
              ]}
            />
          </>
        ) : null}
      </Panel>

      <Panel title="Run history" icon="clock">
        <DataTable
          caption="Run history"
          rows={history}
          empty={<EmptyState title="No runs yet" />}
          columns={[
            { title: "When", render: (r) => new Date(r.at).toLocaleTimeString() },
            { title: "Scenario", key: "scenario" },
            {
              title: "Event",
              num: true,
              render: (r) => (
                <a className="ties-link" href={`#/explorer/${r.eventId}`}>
                  #{r.eventId}
                </a>
              ),
            },
            { title: "Ended", key: "status" },
            { title: "Rounds", num: true, key: "rounds" },
            { title: "Txs", num: true, key: "txCount" },
            { title: "Wrong", num: true, key: "wrong" },
            {
              title: "Result",
              render: (r) => (
                <StatusChip status={r.ok ? "pay" : "held"} label={r.ok ? "OK" : "Check"} />
              ),
            },
          ]}
        />
      </Panel>
    </>
  );
}
