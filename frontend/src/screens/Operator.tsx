import { useMemo, useState } from "react";
import type { Contract } from "ethers";
import {
  Address,
  Banner,
  Button,
  DataTable,
  EmptyState,
  KeyValue,
  PageHeader,
  Panel,
  Sparkline,
  StatusChip,
  TxFlow,
  TxHash,
} from "../components";
import { useChainClock, useContracts, useNetwork, useTx, useWallet } from "../hooks";
import { useContractEvents } from "../hooks/data";
import { useCategories, useEventList } from "../hooks/events";
import { useSources } from "../hooks/lookups";
import {
  StoredReport,
  commitHashOf,
  loadReport,
  randomSalt,
  saveReport,
  toolArgs,
} from "../lib/report";
import { fmtDuration } from "../lib/format";
import { useEffect } from "react";

interface Registration {
  category: number;
  active: boolean;
  primary: boolean;
  sourceId: number;
}

/** Oracle operator console: registration (read-only), source adapter, reputation, inbox, commit and reveal. */
export function Operator() {
  const { read, getWriteContracts } = useContracts();
  const { info, chainId } = useNetwork();
  const { account } = useWallet();
  const now = useChainClock();
  const cats = useCategories();
  const sources = useSources();
  const { events } = useEventList();
  const tx = useTx();
  const [regs, setRegs] = useState<Registration[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const opened = useContractEvents(["RoundOpened"]);
  const committed = useContractEvents(["ReportCommitted"]);
  const revealed = useContractEvents(["ReportRevealed"]);
  const reputation = useContractEvents(["ReputationUpdated"]);
  const finalized = useContractEvents(["EventFinalized"]);
  const me = (account ?? "").toLowerCase();

  useEffect(() => {
    if (!read || !account) return setRegs([]);
    let alive = true;
    void (async () => {
      const out: Registration[] = [];
      for (const c of cats) {
        const o = await read.registry.getOracle(account, c.category);
        if (o.registered)
          out.push({
            category: c.category,
            active: o.active,
            primary: o.primary,
            sourceId: Number(o.sourceId),
          });
      }
      if (alive) setRegs(out);
    })();
    return () => {
      alive = false;
    };
  }, [read, account, cats.length]);

  const inbox = useMemo(
    () =>
      opened
        .filter((o) => (o.args.committee as string[]).some((a) => a.toLowerCase() === me))
        .map((o) => {
          const eventId = Number(o.args.eventId);
          const round = Number(o.args.round);
          const ev = events?.find((e) => e.id === eventId);
          const current = ev != null && ev.round === round && [1, 2].includes(ev.engineStatus);
          return {
            eventId,
            round,
            label: ev?.label ?? `Event ${eventId}`,
            category: ev?.category ?? 0,
            key: ev?.key ?? "",
            commitDeadline: Number(o.args.commitDeadline),
            revealDeadline: Number(o.args.revealDeadline),
            current,
            committed: committed.some(
              (c) =>
                Number(c.args.eventId) === eventId &&
                Number(c.args.round) === round &&
                String(c.args.oracle).toLowerCase() === me,
            ),
            revealed: revealed.some(
              (c) =>
                Number(c.args.eventId) === eventId &&
                Number(c.args.round) === round &&
                String(c.args.oracle).toLowerCase() === me,
            ),
          };
        })
        .reverse(),
    [opened, committed, revealed, events, me],
  );

  const commit = async (row: (typeof inbox)[number]) => {
    setNote(null);
    const reg = regs.find((r) => r.category === row.category);
    if (!reg || !account) return;
    if (info.key !== "local") {
      setNote(
        "Fetching a report by hand is available on localhost only; on Sepolia the oracle node does this.",
      );
      return;
    }
    let report: StoredReport;
    try {
      const res = await fetch(`http://127.0.0.1:${7100 + reg.sourceId}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toolArgs(row.category, row.key, row.eventId)),
      });
      if (!res.ok) throw new Error(`source answered ${res.status}`);
      report = { ...(await res.json()), salt: randomSalt() };
    } catch (err) {
      setNote(
        `Could not fetch a signed report from the source: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    saveReport(chainId, row.eventId, row.round, account, report);
    await tx.run(`Commit · event ${row.eventId} round ${row.round}`, async () => {
      const c = await getWriteContracts();
      return (c.engine as Contract).commit(row.eventId, row.round, commitHashOf(report, account));
    });
  };

  const reveal = async (row: (typeof inbox)[number]) => {
    if (!account) return;
    const r = loadReport(chainId, row.eventId, row.round, account);
    if (!r) {
      setNote(
        "The salt for this commit was not found in this browser, so it cannot be revealed. The report will count as missed.",
      );
      return;
    }
    await tx.run(`Reveal · event ${row.eventId} round ${row.round}`, async () => {
      const c = await getWriteContracts();
      return (c.engine as Contract).reveal(
        row.eventId,
        row.round,
        BigInt(r.value),
        r.ts,
        r.toolHash,
        r.argsHash,
        r.responseHash,
        r.signature,
        r.salt,
        { gasLimit: 900_000 },
      );
    });
  };

  if (!account)
    return <EmptyState title="Connect a wallet to open the operator console" icon="wallet" />;

  const history = revealed.filter((r) => String(r.args.oracle).toLowerCase() === me).reverse();
  const finalOf = (eventId: number) => finalized.find((f) => Number(f.args.eventId) === eventId);

  return (
    <>
      <PageHeader
        eyebrow="Oracle"
        title="Operator console"
        subtitle="Oracle keys are registered by the admin. This console shows the same actions the oracle node performs automatically."
      />
      {regs.length === 0 ? (
        <Banner tone="held" title="This account is not a registered oracle">
          Ask the admin to register it. Registration is not self-service.
        </Banner>
      ) : null}
      {note ? (
        <Banner tone="held" title="Heads up">
          {note}
        </Banner>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: 16,
        }}
      >
        {regs.map((r) => {
          const src = sources.get(r.sourceId);
          const cat = cats.find((c) => c.category === r.category);
          const rep = reputation.filter(
            (e) =>
              String(e.args.oracle).toLowerCase() === me && Number(e.args.category) === r.category,
          );
          const series = rep.map(
            (e) => Number(e.args.alpha) / (Number(e.args.alpha) + Number(e.args.beta)),
          );
          return (
            <Panel
              key={r.category}
              title={cat?.name ?? `Category ${r.category}`}
              icon="server"
              badge={
                <StatusChip
                  status={r.active ? "running" : "stopped"}
                  label={r.active ? "Active" : "Inactive"}
                />
              }
            >
              <KeyValue
                items={[
                  ["Source", src ? `${src.name} (S${r.sourceId})` : `S${r.sourceId}`],
                  ["Source signer", src ? <Address key="s" value={src.signer} /> : "—"],
                  ["Round-1 committee", r.primary ? "Yes" : "No (recruited on escalation)"],
                  [
                    "MCP endpoint",
                    info.key === "local" ? (
                      <span
                        key="m"
                        className="ties-mono"
                      >{`http://127.0.0.1:${7100 + r.sourceId}/mcp`}</span>
                    ) : (
                      "set by the node operator"
                    ),
                  ],
                  [
                    "Reputation",
                    series.length ? `${(series[series.length - 1] * 100).toFixed(1)}%` : "initial",
                  ],
                ]}
              />
              {series.length > 1 ? (
                <Sparkline values={series} width={200} height={32} label="Reputation over time" />
              ) : null}
            </Panel>
          );
        })}
      </div>
      <Panel title="Inbox" icon="list">
        <DataTable
          caption="Report requests"
          rows={inbox}
          empty={
            <EmptyState
              title="No requests"
              body="You are asked to report when an event's round opens with your key on the committee."
            />
          }
          columns={[
            {
              title: "Event",
              render: (r) => (
                <a className="ties-link" href={`#/explorer/${r.eventId}`}>
                  {r.label}
                </a>
              ),
            },
            { title: "Round", num: true, key: "round" },
            {
              title: "Window",
              render: (r) =>
                r.current
                  ? now < r.commitDeadline
                    ? `Commit · ${fmtDuration(r.commitDeadline - now)} left`
                    : now < r.revealDeadline
                      ? `Reveal · ${fmtDuration(r.revealDeadline - now)} left`
                      : "Awaiting finalize"
                  : "Closed",
            },
            {
              title: "Status",
              render: (r) =>
                r.revealed ? (
                  <StatusChip status="confirmed" label="Revealed" />
                ) : r.committed ? (
                  <StatusChip status="commit" label="Committed" />
                ) : r.current ? (
                  <StatusChip status="pending" label="Needs a report" />
                ) : (
                  <StatusChip status="reverted" label="Missed · reputation penalty" />
                ),
            },
            {
              title: "",
              render: (r) =>
                r.current && !r.committed && now < r.commitDeadline ? (
                  <Button size="sm" onClick={() => void commit(r)}>
                    Fetch and commit
                  </Button>
                ) : r.current &&
                  r.committed &&
                  !r.revealed &&
                  now >= r.commitDeadline &&
                  now < r.revealDeadline ? (
                  <Button size="sm" onClick={() => void reveal(r)}>
                    Reveal
                  </Button>
                ) : null,
            },
          ]}
        />
        {tx.state !== "idle" ? (
          <div style={{ marginTop: 12 }}>
            <TxFlow
              state={tx.state}
              hash={tx.data.hash}
              block={tx.data.block}
              gas={tx.data.gas}
              reason={tx.data.reason}
              raw={tx.data.raw}
              network={info.key}
            >
              <Button size="sm" variant="ghost" onClick={tx.reset}>
                Dismiss
              </Button>
            </TxFlow>
          </div>
        ) : null}
        <div className="ties-field__hint" style={{ marginTop: 8 }}>
          The salt of each commit is kept in this browser (local storage). If it is lost, the reveal
          is impossible and the report counts as missed.
        </div>
      </Panel>
      <Panel title="History and accuracy" icon="check">
        <DataTable
          caption="Reports"
          rows={history}
          empty={<EmptyState title="No reports yet" />}
          columns={[
            {
              title: "Event",
              render: (r) => `#${String(r.args.eventId)} · round ${String(r.args.round)}`,
            },
            {
              title: "Reported",
              num: true,
              render: (r) => (Number(r.args.value) / 1000).toFixed(1),
            },
            {
              title: "Final value",
              num: true,
              render: (r) => {
                const f = finalOf(Number(r.args.eventId));
                return f ? (Number(f.args.finalValue) / 1000).toFixed(1) : "—";
              },
            },
            {
              title: "Accuracy",
              render: (r) => {
                const f = finalOf(Number(r.args.eventId));
                if (!f) return <StatusChip status="pending" label="Not final" />;
                const ev = events?.find((e) => e.id === Number(r.args.eventId));
                const p = cats.find((c) => c.category === ev?.category)?.params;
                const tol = p ? (Number(p.eps) / 1e18) * (Number(p.s) / 1000) : 0;
                const err = Math.abs(Number(r.args.value) - Number(f.args.finalValue)) / 1000;
                return err <= tol ? (
                  <StatusChip status="pay" label={`Within ${tol.toFixed(1)}`} />
                ) : (
                  <StatusChip status="held" label={`Off by ${err.toFixed(1)}`} />
                );
              },
            },
            { title: "Tx", render: (r) => <TxHash hash={r.txHash} network={info.key} /> },
          ]}
        />
      </Panel>
    </>
  );
}
