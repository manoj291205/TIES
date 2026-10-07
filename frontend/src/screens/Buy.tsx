import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { formatEther, parseEther } from "ethers";
import type { Contract } from "ethers";
import {
  Banner,
  Button,
  CapacityMeter,
  EmptyState,
  KeyValue,
  PageHeader,
  Panel,
  Skeleton,
  Stepper,
  TextField,
  ThresholdSlider,
  TxFlow,
} from "../components";
import { useChainClock, useContracts, useNetwork, useTx, useWallet } from "../hooks";
import { useEventList, useEventParams } from "../hooks/events";
import { fmtEth, fmtWei, weiToEth } from "../lib/format";
import { WAD, interpolate, mulWadUp } from "../../../packages/ties-math/src";
import { decodeError } from "../lib/errors";
import { allInterfaces } from "../lib/contracts";

/** Buy cover: choose a threshold and payout, see the contract's quote, and bind a policy. */
export function Buy() {
  const { id } = useParams();
  const { events } = useEventList();
  if (!id) {
    if (events === null) return <Skeleton h={40} />;
    const open = events.filter((e) => e.status === "open");
    if (open.length === 0) {
      return (
        <EmptyState
          title="No event is open for cover"
          body="Binding closes at each event's cutoff."
        />
      );
    }
    return <Navigate to={`/buy/${open[open.length - 1].id}`} replace />;
  }
  return <BuyFor eventId={Number(id)} />;
}

function BuyFor({ eventId }: { eventId: number }) {
  const nav = useNavigate();
  const { read, getWriteContracts } = useContracts();
  const { info, block, readProvider } = useNetwork();
  const { account, connect } = useWallet();
  const now = useChainClock();
  const { events } = useEventList();
  const row = events?.find((e) => e.id === eventId);
  const params = useEventParams(row?.category, row?.version);
  const tx = useTx();

  const [threshold, setThreshold] = useState(120);
  const [payoutText, setPayoutText] = useState("1");
  const [histogram, setHistogram] = useState<{ x: number; v: number }[]>([]);
  const [win, setWin] = useState(5);
  const [used, setUsed] = useState(0);
  const [left, setLeft] = useState<bigint | null>(null);
  const [premium, setPremium] = useState<bigint | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<number | null>(null);
  const [share, setShare] = useState<{ locked: bigint; allowed: bigint } | null>(null);
  const [gas, setGas] = useState<string | null>(null);

  let payout: bigint | null = null;
  let payoutError: string | undefined;
  try {
    payout = parseEther(payoutText || "0");
    if (payout <= 0n) {
      payout = null;
      payoutError = "The payout must be greater than zero.";
    }
  } catch {
    payoutError = "Enter an amount in ETH, e.g. 1.5";
  }

  const bucketCount = params?.bucketCount ?? 721;
  const unit = row?.unit ?? "min";
  const open = row ? now < row.cutoff && row.engineStatus === 0 : false;

  // Existing cover and the capacity window around the threshold.
  useEffect(() => {
    if (!read) return;
    let alive = true;
    void (async () => {
      try {
        const amounts = (await read.book.bucketsInRange(eventId, 0, bucketCount - 1)) as bigint[];
        const w = Number(await read.book.windowOf(eventId));
        if (!alive) return;
        setWin(w);
        const hist = amounts.map((a, x) => ({ x, v: weiToEth(a) })).filter((b) => b.v > 0);
        setHistogram(hist);
        setUsed(hist.filter((b) => Math.abs(b.x - threshold) <= w).reduce((t, b) => t + b.v, 0));
      } catch {
        /* keep previous */
      }
    })();
    return () => {
      alive = false;
    };
  }, [read, eventId, bucketCount, threshold, block?.number]);

  // Quote and capacity, debounced.
  useEffect(() => {
    if (!read || payout === null) {
      setPremium(null);
      return;
    }
    let alive = true;
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const q = (await read.book.quote(eventId, threshold, payout)) as bigint;
          const cap = (await read.book.capacityLeftNear(eventId, threshold)) as bigint;
          const [locked, free] = await Promise.all([
            read.book.eventLocked(eventId) as Promise<bigint>,
            read.vault.freeLiquidity() as Promise<bigint>,
          ]);
          if (alive && params) setShare({ locked, allowed: (free * params.eta) / WAD });
          if (!alive) return;
          setPremium(q);
          setLeft(cap);
          setQuoteError(null);
          if (cap < payout) {
            try {
              const near = Number(
                await read.book.nearestAvailableBucket(eventId, threshold, payout),
              );
              if (alive) setSuggest(near);
            } catch {
              if (alive) setSuggest(null);
            }
          } else setSuggest(null);
        } catch (err) {
          if (alive) {
            setPremium(null);
            setQuoteError(
              decodeError(
                err,
                allInterfaces().map((x) => x.iface),
              ).message,
            );
          }
        }
      })();
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [read, eventId, threshold, payoutText, block?.number, params]);

  // Premium split, rebuilt from the event's parameters with the contract's rounding.
  let split: { risk: bigint; margin: bigint; fee: bigint } | null = null;
  if (params && payout !== null && premium !== null) {
    const q = interpolate(
      params.curveTheta,
      params.curveProb,
      BigInt(threshold) * params.bucketWidth,
    );
    const risk = mulWadUp(payout, q);
    const withMargin = mulWadUp(risk, WAD + params.margin);
    const total = withMargin + params.escalationFee;
    const diff = total > premium ? total - premium : premium - total;
    if (diff <= 1n) split = { risk, margin: withMargin - risk, fee: params.escalationFee };
  }

  const full = left !== null && payout !== null && left < payout;
  const cap = params ? weiToEth(params.capacityCapPerWindow) : 10;
  const overShare = share !== null && payout !== null && share.locked + payout > share.allowed;
  const blocked = !open
    ? "Binding for this event is closed."
    : (payoutError ??
      quoteError ??
      (overShare
        ? `This event would lock ${fmtWei(share!.locked + payout!)} ETH, above the ${fmtWei(share!.allowed)} ETH the vault allows for one event. Try a smaller payout.`
        : null) ??
      (full
        ? `Too much cover near ${threshold} ${unit}${suggest != null ? ` — try ${suggest}+ ${unit}` : ""}.`
        : null));

  // Gas estimate for the review.
  useEffect(() => {
    setGas(null);
    if (!account || !premium || payout === null || blocked) return;
    let alive = true;
    void (async () => {
      try {
        const c = await getWriteContracts();
        const est = (await (c.book as Contract).bind.estimateGas(eventId, threshold, payout, {
          value: premium,
        })) as bigint;
        const fee = await readProvider.getFeeData();
        const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
        if (alive) setGas(`${est.toLocaleString("en-US")} gas · ≈ ${fmtWei(est * price, 6)} ETH`);
      } catch {
        /* the review still works without an estimate */
      }
    })();
    return () => {
      alive = false;
    };
  }, [account, premium, threshold, payoutText, blocked]);

  const sign = () =>
    void tx.run(`Buy cover · event ${eventId} · ≥ ${threshold} ${unit}`, async () => {
      const c = await getWriteContracts();
      return (c.book as Contract).bind(eventId, threshold, payout, { value: premium });
    });

  if (!row || !params) return <Skeleton h={300} />;
  const step = tx.state !== "idle" ? 4 : payout !== null ? 3 : 2;
  const bound = tx.data.events.find((e) => e.name === "PolicyBound");

  return (
    <>
      <PageHeader
        eyebrow="Buy cover"
        title={row.label}
        subtitle={`Pays your payout if the ${row.kind === "flight" ? "arrival delay" : "24 h rainfall"} is at least the threshold. The premium is quoted by the contract.`}
        meta={<Stepper steps={["Event", "Threshold", "Payout", "Review", "Sign"]} current={step} />}
      />
      {!open ? (
        <Banner tone="held" title="Binding is closed for this event">
          The cutoff has passed or evidence rounds have started.
        </Banner>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 380px",
          gap: 24,
          alignItems: "start",
        }}
      >
        <div className="ties-stack">
          <Panel title="Threshold" icon="sliders">
            <ThresholdSlider
              value={threshold}
              onChange={setThreshold}
              min={0}
              max={bucketCount - 1}
              unit={unit}
              metric={row.kind === "flight" ? "delay" : "rainfall"}
              window={win}
              histogram={histogram}
              capacityMax={cap}
              error={full}
              ticks={Array.from({ length: 7 }, (_, i) => Math.round(((bucketCount - 1) / 6) * i))}
            />
            <CapacityMeter
              used={used}
              max={cap}
              note={
                full
                  ? `Too much cover near ${threshold} ${unit}${suggest != null ? ` — try ${suggest}+ ${unit}` : ""}.`
                  : `Cover already bound within ±${win} ${unit} of this threshold.`
              }
            />
          </Panel>
          <Panel title="Payout" icon="vault">
            <TextField
              label="Payout if triggered"
              value={payoutText}
              onChange={setPayoutText}
              suffix="ETH"
              mono
              error={payoutError}
              hint="Locked as collateral in the vault until the event settles."
            />
          </Panel>
        </div>
        <div className="ties-stack" style={{ position: "sticky", top: 16 }}>
          <Panel title="Review" icon="eye">
            {premium === null ? (
              <p className="ties-muted" style={{ margin: 0 }}>
                {quoteError ?? "Enter a payout to see the quote."}
              </p>
            ) : (
              <KeyValue
                items={[
                  ["Premium (contract quote)", <b key="p">{fmtWei(premium)} ETH</b>],
                  ...(split
                    ? ([
                        ["· pure risk", `${fmtWei(split.risk)} ETH`],
                        ["· margin", `${fmtWei(split.margin)} ETH`],
                        ["· escalation fee", `${fmtWei(split.fee)} ETH`],
                      ] as [string, string][])
                    : []),
                  ["Payout locked", `${fmtEth(payout ? Number(formatEther(payout)) : null)} ETH`],
                  [
                    "Call",
                    <span key="c" className="ties-mono" style={{ fontSize: 12 }}>
                      PolicyBook.bind({eventId}, {threshold}, {payout?.toString() ?? "…"})
                    </span>,
                  ],
                  ["Network fee", gas ?? (account ? "estimating…" : "connect to estimate")],
                ]}
              />
            )}
            {split ? (
              <div className="ties-field__hint" style={{ marginTop: 6 }}>
                Split computed from category parameters; the total is what the contract charges.
              </div>
            ) : null}
            <div style={{ marginTop: 12 }}>
              {!account ? (
                <Button block icon="wallet" onClick={() => void connect().catch(() => undefined)}>
                  Connect MetaMask
                </Button>
              ) : (
                <Button
                  block
                  disabled={blocked !== null || premium === null}
                  loading={tx.state === "awaiting" || tx.state === "pending"}
                  onClick={sign}
                >
                  {tx.state === "rejected" ? "Try again" : "Buy cover"}
                </Button>
              )}
              {blocked && account ? (
                <div className="ties-field__error" role="alert" style={{ marginTop: 6 }}>
                  {blocked}
                </div>
              ) : null}
            </div>
          </Panel>
          {tx.state !== "idle" ? (
            <TxFlow
              state={tx.state}
              hash={tx.data.hash}
              block={tx.data.block}
              gas={tx.data.gas}
              reason={tx.data.reason}
              raw={tx.data.raw}
              network={info.key}
              action="PolicyBook.bind"
              result={
                bound
                  ? ["Policy", `#${String(bound.args.policyId)} · ≥ ${threshold} ${unit}`]
                  : undefined
              }
            >
              {tx.state === "confirmed" ? (
                <>
                  <Button size="sm" onClick={() => nav("/policies")}>
                    View in My policies
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => nav(`/explorer/${eventId}`)}>
                    View event settlement
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={tx.reset}>
                  Edit
                </Button>
              )}
            </TxFlow>
          ) : null}
        </div>
      </div>
    </>
  );
}
