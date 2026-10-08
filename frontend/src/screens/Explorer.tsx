import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import type { Contract } from "ethers";
import {
  Banner,
  Button,
  EmptyState,
  EscalationPanel,
  IntervalChart,
  MoneySplit,
  NeffGauge,
  PageHeader,
  Panel,
  RoundTimeline,
  SegmentedControl,
  Skeleton,
  SourceList,
  StatusChip,
  TxFlow,
  TimelineRound,
  Report,
  StatusKey,
} from "../components";
import { useChainClock, useContracts, useNetwork, useTx, useWallet } from "../hooks";
import { useContractEvents, useEventState } from "../hooks/data";
import { useEventList, useEventParams } from "../hooks/events";
import { useMyPolicies, useOracleSources, useSources } from "../hooks/lookups";
import { fmtDuration, fmtEth, weiToEth } from "../lib/format";
import { aggregate, roundInterval } from "../../../packages/ties-math/src";

const OUTCOME = ["INSUFFICIENT", "VALID", "DISPUTED"];
const REASON = ["inconsistent evidence", "a challenge", "evidence that never became sufficient"];
const num = (v: unknown) => Number(v);

/** Settlement explorer: the interval, the money on either side of it, and how it got there. */
export function Explorer() {
  const { id } = useParams();
  const { events } = useEventList();
  if (!id) {
    if (events === null) return <Skeleton h={40} />;
    if (events.length === 0) {
      return <EmptyState title="No events yet" body="Ask the admin to create an event." />;
    }
    return <Navigate to={`/explorer/${events[events.length - 1].id}`} replace />;
  }
  return <ExplorerFor eventId={Number(id)} />;
}

function ExplorerFor({ eventId }: { eventId: number }) {
  const nav = useNavigate();
  const { read, getWriteContracts } = useContracts();
  const { info } = useNetwork();
  const { account } = useWallet();
  const now = useChainClock();
  const { events } = useEventList();
  const { view, error, loading } = useEventState(eventId);
  const row = events?.find((e) => e.id === eventId);
  const params = useEventParams(row?.category, row?.version);
  const sources = useSources();
  const mine = useMyPolicies();
  const tx = useTx();
  const [zoom, setZoom] = useState<"near" | "full">("near");
  const [amounts, setAmounts] = useState<bigint[]>([]);

  const sameEvent = (e: { args: Record<string, unknown> }) => num(e.args.eventId) === eventId;
  const finalized = useContractEvents(["RoundFinalized"], sameEvent);
  const revealed = useContractEvents(["ReportRevealed"], sameEvent);
  const committed = useContractEvents(["ReportCommitted"], sameEvent);
  const escalations = useContractEvents(["EscalationRequested"], sameEvent);
  const opened = useContractEvents(["RoundOpened"], sameEvent);
  const bound = useContractEvents(["PolicyBound"], sameEvent);
  const lastEvent = useContractEvents(
    [
      "RoundFinalized",
      "EscalationRequested",
      "EventDisputed",
      "EventFinalized",
      "EventDefaultPending",
      "DefaultApplied",
      "DisputeResolved",
    ],
    sameEvent,
  ).at(-1);

  // Collateral per bucket.
  useEffect(() => {
    if (!read || !view || view.bucketCount === 0) return;
    let alive = true;
    read.book
      .bucketsInRange(eventId, 0, view.bucketCount - 1)
      .then((a: bigint[]) => alive && setAmounts([...a]))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [read, view?.bucketCount, bound.length, finalized.length, eventId]);

  const unit = row?.unit ?? "min";
  const myBuckets = new Set((mine ?? []).filter((p) => p.eventId === eventId).map((p) => p.bucket));
  const nonZero = amounts.map((a, x) => ({ x, amount: weiToEth(a) })).filter((b) => b.amount > 0);
  const domain: [number, number] = useMemo(() => {
    const full: [number, number] = [0, Math.max(1, (view?.bucketCount ?? 721) - 1)];
    if (zoom === "full" || nonZero.length === 0) return full;
    let lo = Math.min(...nonZero.map((b) => b.x));
    let hi = Math.max(...nonZero.map((b) => b.x));
    if (view?.hasInterval) {
      lo = Math.min(lo, Number(view.lower) / 1000);
      if (view.upper < 10n ** 30n) hi = Math.max(hi, Number(view.upper) / 1000);
    }
    lo = Math.max(0, Math.floor(lo) - 20);
    hi = Math.min(full[1], Math.ceil(hi) + 20);
    return hi - lo < 40 ? [Math.max(0, lo - 20), Math.min(full[1], hi + 20)] : [lo, hi];
  }, [zoom, nonZero.length, view?.bucketCount, view?.lower, view?.upper, view?.hasInterval]);

  // Rounds.
  const timeline: TimelineRound[] = finalized.map((f, i) => {
    const round = num(f.args.round);
    const outcome = OUTCOME[num(f.args.status)];
    const V = f.args.V as bigint;
    const sigma = f.args.sigma as bigint;
    const iv =
      outcome === "VALID" && params
        ? roundInterval(V, sigma, params.zByRound[Math.min(round, params.zByRound.length) - 1])
        : null;
    const moved = (f.args.newPay as bigint) + (f.args.newNoPay as bigint);
    const escalated = escalations.some((e) => num(e.args.nextRound) === round + 1);
    const reports = revealed.filter((r) => num(r.args.round) === round).length;
    let status: StatusKey = "settled";
    let statusLabel: string | undefined;
    if (outcome === "INSUFFICIENT") {
      status = "insufficient";
      statusLabel = `N_eff ${(Number(f.args.nEff) / 1e18).toFixed(1)} < ${(Number(params?.nMin ?? 0n) / 1e18).toFixed(1)}${escalated ? " · escalated" : ""}`;
    } else if (outcome === "DISPUTED") {
      status = "disputed";
    } else {
      statusLabel = moved > 0n ? `${fmtEth(weiToEth(moved), 4)} ETH settled` : "Interval narrowed";
    }
    return {
      n: round,
      sub: `${reports} report${reports === 1 ? "" : "s"}`,
      L: iv ? Number(iv.lo) / 1000 : null,
      U: iv ? Number(iv.hi) / 1000 : null,
      V: iv ? Number(V) / 1000 : null,
      neff: iv ? Number(f.args.nEff) / 1e18 : null,
      status,
      statusLabel,
      tx: f.txHash,
      note: outcome === "INSUFFICIENT" ? "Not enough independent sources" : undefined,
      key: i,
    } as TimelineRound;
  });
  const openStatus = view && (view.status === "ROUND_COMMIT" || view.status === "ROUND_REVEAL");
  if (openStatus && view && !finalized.some((f) => num(f.args.round) === view.round)) {
    timeline.push({
      n: view.round,
      sub: view.status === "ROUND_COMMIT" ? "commit open" : "reveal open",
      status: view.status === "ROUND_COMMIT" ? "commit" : "reveal",
      note: "Awaiting reports",
    });
  }

  // Sources and recomputed weights (labelled as computed off-chain).
  const [weights, setWeights] = useState<Map<string, number> | null>(null);
  const lastFinal = finalized.at(-1);
  useEffect(() => {
    setWeights(null);
    if (!read || !params || !lastFinal || row == null) return;
    const round = num(lastFinal.args.round);
    const reps = revealed.filter((r) => num(r.args.round) <= round);
    if (reps.length === 0) return;
    let alive = true;
    void (async () => {
      try {
        const rep = await Promise.all(
          reps.map(
            (r) => read.registry.reputationWeight(r.args.oracle, row.category) as Promise<bigint>,
          ),
        );
        const ids = reps.map((r) => num(r.args.sourceId));
        const flat = (await read.registry.dependenceMatrix(ids, params.rho0)) as bigint[];
        const n = ids.length;
        const rho = Array.from({ length: n }, (_, i) =>
          Array.from({ length: n }, (_, j) => flat[i * n + j]),
        );
        const result = aggregate({
          x: reps.map((r) => r.args.value as bigint),
          rep,
          rho,
          s: params.s,
          sigmaFloor: params.sigmaFloor,
          delta: params.delta,
          dCut: params.dCut,
        });
        const v = lastFinal.args.V as bigint;
        const ne = lastFinal.args.nEff as bigint;
        const diff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
        const ok = diff(result.consensus, v) <= 1n && diff(result.nEff, ne) <= ne / 1_000_000n + 1n;
        if (alive && ok) {
          setWeights(
            new Map(
              reps.map((r, i) => [
                String(r.args.oracle).toLowerCase(),
                Number(result.weights[i]) / 1e18,
              ]),
            ),
          );
        }
      } catch {
        /* weights stay hidden */
      }
    })();
    return () => {
      alive = false;
    };
  }, [read, params, lastFinal?.txHash, revealed.length, row?.category]);

  const reports: Report[] = revealed.map((r) => {
    const sid = num(r.args.sourceId);
    const name = sources.get(sid)?.name ?? `Source ${sid}`;
    const w = weights?.get(String(r.args.oracle).toLowerCase());
    const sourceW = weights
      ? revealed
          .filter((x) => num(x.args.sourceId) === sid)
          .reduce((a, x) => a + (weights.get(String(x.args.oracle).toLowerCase()) ?? 0), 0)
      : null;
    return {
      source: name,
      proof: "mcp",
      oracle: String(r.args.oracle),
      value: Number(r.args.value) / 1000,
      weight: w != null ? w.toFixed(2) : "—",
      sourceWeight: sourceW != null ? sourceW.toFixed(2) : "—",
      block: r.block,
      tx: r.txHash,
      round: num(r.args.round),
      isNew:
        view != null && num(r.args.round) === view.round && view.round > 1 && openStatus === true,
    };
  });

  // Money and policies.
  const payCount = bound.filter((b) => view && num(b.args.bucket) <= view.payCursor).length;
  const noPayCount = bound.filter((b) => view && num(b.args.bucket) >= view.noPayCursor).length;
  const heldCount = bound.length - payCount - noPayCount;
  const min = params ? Number(params.nMin) / 1e18 : 1.8;

  // Escalation panel.
  const esc = escalations.filter((e) => view && num(e.args.nextRound) === view.round).at(-1);
  const escSources = useOracleSources(
    (esc?.args.selected as string[] | undefined) ?? [],
    row?.category,
  );
  const escNames = ((esc?.args.selected as string[] | undefined) ?? []).map(
    (a) => sources.get(escSources[a.toLowerCase()])?.name ?? a.slice(0, 8),
  );
  const roundOpened = opened.filter((o) => view && num(o.args.round) === view.round).at(-1);
  const committee = (roundOpened?.args.committee as string[] | undefined) ?? [];
  const committeeSources = useOracleSources(committee, row?.category);
  const committeeNames = committee.map(
    (a) => sources.get(committeeSources[a.toLowerCase()])?.name ?? a.slice(0, 8),
  );
  const commitsIn = view ? committed.filter((c) => num(c.args.round) === view.round).length : 0;

  // Settle now.
  const action = (() => {
    if (!view) return null;
    if (view.status === "NONE") {
      return now >= (row?.observationEnd ?? Infinity)
        ? { fn: "openRound", label: "Open round 1", why: "" }
        : {
            fn: "openRound",
            label: "Open round 1",
            why: "The observation window has not ended yet.",
          };
    }
    if (view.status === "ROUND_COMMIT" || view.status === "ROUND_REVEAL") {
      return now >= view.revealDeadline
        ? { fn: "finalizeRound", label: "Settle now", why: "" }
        : {
            fn: "finalizeRound",
            label: "Settle now",
            why: `Reveal window open for ${fmtDuration(view.revealDeadline - now)} more.`,
          };
    }
    if (view.status === "DEFAULT_PENDING") {
      return now >= view.challengeDeadline
        ? { fn: "applyDefault", label: "Apply default", why: "" }
        : {
            fn: "applyDefault",
            label: "Apply default",
            why: `Challenge period ends in ${fmtDuration(view.challengeDeadline - now)}.`,
          };
    }
    return null;
  })();

  const send = async (fn: string, label: string, value?: bigint) => {
    await tx.run(label, async () => {
      const c = await getWriteContracts();
      const engine = c.engine as Contract;
      // Finalizing needs a large gas reserve for the learning update; let the node size it.
      const gas = (await engine[fn].estimateGas(eventId, value ? { value } : {})) as bigint;
      return engine[fn](eventId, { gasLimit: (gas * 115n) / 100n, ...(value ? { value } : {}) });
    });
  };

  if (error)
    return (
      <Banner tone="danger" title="Could not read this event">
        {error}
      </Banner>
    );
  if (loading || !view || !row) return <Skeleton h={300} />;

  const hasIv = view.hasInterval;
  const L = hasIv ? Number(view.lower) / 1000 : null;
  const U = hasIv && view.upper < 10n ** 30n ? Number(view.upper) / 1000 : null;
  const V = hasIv ? Number(view.vLast) / 1000 : null;
  const chartState =
    view.status === "DISPUTED"
      ? "disputed"
      : view.status === "FINAL"
        ? "settled"
        : !hasIv
          ? finalized.length
            ? "insufficient"
            : "awaiting"
          : "live";
  const intersection: [number, number] | undefined =
    hasIv && L != null && U != null ? [L, U] : undefined;
  const finalValue = view.status === "FINAL" ? Number(view.lower) / 1000 : null;

  return (
    <>
      <PageHeader
        eyebrow={`Settlement · event #${eventId} · ${row.kind}`}
        title={row.label}
        subtitle={`Pays if ${row.kind === "flight" ? "arrival delay" : "24 h rainfall"} ≥ threshold · observation ${row.windowText} · bucket 1 ${unit} · escalation trigger ${fmtEth(params ? weiToEth(params.uMin) : null, 1)} ETH · max ${params?.kMax ?? "–"} rounds`}
        meta={
          <>
            <StatusChip status={row.status} label={row.statusLabel} />
            {view.status === "ROUND_COMMIT" ? (
              <StatusChip
                status="commit"
                label={`Round ${view.round} commit · ${fmtDuration(Math.max(0, view.commitDeadline - now))} left`}
              />
            ) : null}
          </>
        }
        actions={
          <>
            <Button variant="secondary" icon="list" onClick={() => nav(`/log?event=${eventId}`)}>
              Event log
            </Button>
            {row.status === "open" ? (
              <Button onClick={() => nav(`/buy/${eventId}`)}>Buy cover</Button>
            ) : null}
          </>
        }
      />

      {lastEvent ? (
        <Banner tone="info" title={`Live · ${lastEvent.name} mined in #${lastEvent.block}`} />
      ) : null}
      {view.status === "DISPUTED" ? (
        <Banner tone="danger" title="Disputed">
          This event is disputed because of {REASON[view.disputeReason]}. Nothing already settled
          reverses and held collateral stays locked until the admin resolves it.
        </Banner>
      ) : null}
      {chartState === "insufficient" && view.status !== "DISPUTED" ? (
        <Banner tone="held" title="Need ≥ 2 independent sources">
          The evidence so far does not reach the minimum N_eff of {min.toFixed(1)}. No collateral
          moves until it does.
        </Banner>
      ) : null}
      {view.status === "FINAL" ? (
        <Banner tone="pay" title={`Fully settled at ${finalValue} ${unit}`}>
          Every policy is settled. Winning policies can be claimed from My policies.
        </Banner>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 360px",
          gap: 24,
          alignItems: "start",
        }}
      >
        <div className="ties-stack">
          <Panel
            title="Threshold axis"
            icon="target"
            actions={
              <SegmentedControl
                label="Zoom"
                value={zoom}
                onChange={(v) => setZoom(v as "near" | "full")}
                options={[
                  { value: "near", label: "Zoomed" },
                  { value: "full", label: `Full 0–${view.bucketCount - 1}` },
                ]}
              />
            }
          >
            <div className="ties-row" style={{ gap: 32, marginBottom: 8 }}>
              <div>
                <div className="ties-label">Interval [L, U]</div>
                <div className="ties-mono ts-mono-lg">
                  {hasIv && L != null
                    ? `[${L.toFixed(1)}, ${U != null ? U.toFixed(1) : "∞"}] ${unit}`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="ties-label">Consensus V</div>
                <div className="ties-mono ts-mono-lg">
                  {V != null ? `${V.toFixed(1)} ${unit}` : "—"}
                </div>
              </div>
              <div>
                <div className="ties-label">Round</div>
                <div className="ties-mono ts-mono-lg">{view.round || "—"}</div>
              </div>
              <div>
                <div className="ties-label">Policies</div>
                <div className="ties-mono ts-mono-lg">
                  {payCount} pay · {heldCount} held · {noPayCount} no pay
                </div>
              </div>
            </div>
            <IntervalChart
              domain={domain}
              full={[0, view.bucketCount - 1]}
              buckets={nonZero.map((b) => ({ ...b, mine: myBuckets.has(b.x) }))}
              bucketSize={1}
              L={L}
              U={U}
              V={V}
              unit={unit}
              state={chartState}
              payCursor={view.status === "NONE" || view.round === 0 ? undefined : view.payCursor}
              noPayCursor={
                view.status === "NONE" || view.round === 0 ? undefined : view.noPayCursor
              }
              prev={timeline
                .filter((t) => t.L != null && t.U != null && t.n < view.round)
                .map((t) => [t.L!, t.U!, `R${t.n}`] as [number, number, string])}
              overview={zoom === "near"}
              height={340}
            />
          </Panel>

          <Panel
            title="Rounds"
            icon="layers"
            badge={
              <span className="ties-subtle" style={{ fontSize: 12 }}>
                Intervals intersect — settlement only moves forward
              </span>
            }
          >
            {timeline.length ? (
              <RoundTimeline
                domain={[Math.floor(domain[0]), Math.ceil(domain[1])]}
                ticks={[domain[0], Math.round((domain[0] + domain[1]) / 2), domain[1]].map(
                  Math.round,
                )}
                rounds={timeline}
                intersection={intersection}
                network={info.key}
              />
            ) : (
              <EmptyState
                title="No round yet"
                body="Round 1 opens after the observation window ends."
              />
            )}
          </Panel>

          <Panel
            title="Sources"
            icon="server"
            badge={
              <span className="ties-subtle" style={{ fontSize: 12 }}>
                {reports.length} reports · {new Set(reports.map((r) => r.source)).size} distinct
                sources{weights ? " · weights computed off-chain" : ""}
              </span>
            }
          >
            {reports.length ? (
              <SourceList reports={reports} unit={unit} network={info.key} />
            ) : (
              <EmptyState
                title="No reports yet"
                body="Oracle nodes commit, then reveal after the commit window closes."
              />
            )}
          </Panel>
        </div>

        <div className="ties-stack">
          <Panel title="Independence" icon="shield">
            <NeffGauge
              value={Number(view.nEffLast) / 1e18}
              min={min}
              detail={`${new Set(reports.map((r) => r.source)).size} distinct sources; keys on one source count once.`}
            />
          </Panel>
          <Panel title="Money on this event" icon="vault">
            <MoneySplit
              title="Collateral locked"
              total={weiToEth(view.locked)}
              segments={[
                {
                  key: "pay",
                  value: weiToEth(view.settledPay),
                  sub: `claimable · ${payCount} ${payCount === 1 ? "policy" : "policies"}`,
                },
                {
                  key: "nopay",
                  value: weiToEth(view.settledNoPay),
                  sub: `${noPayCount} ${noPayCount === 1 ? "policy" : "policies"}`,
                },
                {
                  key: "held",
                  value: weiToEth(view.held),
                  sub: `${heldCount} ${heldCount === 1 ? "policy" : "policies"}`,
                },
              ]}
            />
          </Panel>
          {openStatus && roundOpened ? (
            <Panel title="Escalation" icon="layers">
              <EscalationPanel
                round={view.round}
                held={weiToEth(view.held)}
                trigger={params ? weiToEth(params.uMin) : 0}
                escalated={esc != null}
                sources={esc ? escNames : committeeNames}
                expected={committee.length || undefined}
                phase={view.status === "ROUND_COMMIT" ? "commit" : "reveal"}
                commit={[fmtDuration(Math.max(0, view.commitDeadline - now)), "until reveal opens"]}
                reveal={[
                  fmtDuration(Math.max(0, view.revealDeadline - now)),
                  "until the round can close",
                ]}
                received={commitsIn}
              />
            </Panel>
          ) : null}
          {action ? (
            <Panel title="Settle now" icon="bolt">
              <p className="ties-muted" style={{ margin: 0 }}>
                Anyone can call this. It settles every bucket below L (pay) and above U (no pay)
                with range operations, however many policies there are.
              </p>
              <div className="ties-row" style={{ marginTop: 12 }}>
                <Button
                  icon="bolt"
                  block
                  disabled={action.why !== "" || !account}
                  loading={tx.state === "awaiting" || tx.state === "pending"}
                  onClick={() => void send(action.fn, `${action.label} · event ${eventId}`)}
                >
                  {action.label}
                </Button>
              </div>
              <div className="ties-field__hint" style={{ marginTop: 6 }}>
                {!account
                  ? "Connect MetaMask to send this."
                  : action.why || `Calls SettlementEngine.${action.fn}(${eventId}).`}
              </div>
              {view.status === "DEFAULT_PENDING" && now < view.challengeDeadline ? (
                <div style={{ marginTop: 12 }}>
                  <Button
                    variant="danger"
                    block
                    disabled={!account}
                    onClick={() =>
                      void send(
                        "challenge",
                        `Challenge · event ${eventId}`,
                        50_000_000_000_000_000n,
                      )
                    }
                  >
                    Challenge (0.05 ETH bond)
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
                    network={info.key}
                    action={`SettlementEngine.${action.fn}`}
                  >
                    <Button size="sm" variant="ghost" onClick={tx.reset}>
                      Dismiss
                    </Button>
                  </TxFlow>
                </div>
              ) : null}
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
