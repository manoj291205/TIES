import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Contract } from "ethers";
import {
  Amount,
  Banner,
  Button,
  DataTable,
  EmptyState,
  IntervalBar,
  PageHeader,
  StatTile,
  StatusChip,
  StatusKey,
  TxHash,
} from "../components";
import { useChainClock, useContracts, useNetwork, useTx, useWallet } from "../hooks";
import { STATUS_NAMES, useContractEvents } from "../hooks/data";
import { useEventList } from "../hooks/events";
import { PolicyView, useMyPolicies } from "../hooks/lookups";
import { weiToEth } from "../lib/format";

interface EventSnap {
  status: string;
  hasInterval: boolean;
  lower: number;
  upper: number | null;
  payCursor: number;
  noPayCursor: number;
  bucketCount: number;
}

interface Row extends PolicyView {
  label: string;
  unit: string;
  snap?: EventSnap;
  status: StatusKey;
  claimTx?: string;
  [key: string]: unknown;
}

/** My policies: status of each, with one-click claims. */
export function Policies() {
  const nav = useNavigate();
  const { read, getWriteContracts } = useContracts();
  const { info, block } = useNetwork();
  const { account, connect } = useWallet();
  const now = useChainClock();
  const { events } = useEventList();
  const policies = useMyPolicies();
  const claims = useContractEvents(
    ["Claimed"],
    (e) => String(e.args.holder).toLowerCase() === (account ?? "").toLowerCase(),
  );
  const tx = useTx();
  const [snaps, setSnaps] = useState<Record<number, EventSnap>>({});
  const ids = [...new Set((policies ?? []).map((p) => p.eventId))].join(",");

  useEffect(() => {
    if (!read || !ids) return;
    let alive = true;
    void (async () => {
      const out: Record<number, EventSnap> = {};
      for (const id of ids.split(",").map(Number)) {
        try {
          const st = await read.engine.eventState(id);
          const pay = Number(await read.engine.payCursor(id));
          const noPay = Number(await read.engine.noPayCursor(id));
          out[id] = {
            status: STATUS_NAMES[Number(st.status)],
            hasInterval: st.hasInterval,
            lower: Number(st.lowerBound) / 1000,
            upper: st.upperBound < 10n ** 30n ? Number(st.upperBound) / 1000 : null,
            payCursor: pay,
            noPayCursor: noPay,
            bucketCount: Number(st.bucketCount),
          };
        } catch {
          /* skip */
        }
      }
      if (alive) setSnaps(out);
    })();
    return () => {
      alive = false;
    };
  }, [read, ids, block?.number]);

  const rows: Row[] = (policies ?? []).map((p) => {
    const ev = events?.find((e) => e.id === p.eventId);
    const snap = snaps[p.eventId];
    let status: StatusKey = "bound";
    if (snap && snap.status !== "NONE") {
      if (p.bucket <= snap.payCursor) status = p.claimed ? "claimed" : "claimable";
      else if (p.bucket >= snap.noPayCursor && snap.noPayCursor < snap.bucketCount)
        status = "nopay";
      else if (snap.status === "DISPUTED") status = "disputed";
      else status = "held";
    } else if (ev && now >= ev.observationEnd) status = "awaiting";
    return {
      ...p,
      label: ev?.label ?? `Event ${p.eventId}`,
      unit: ev?.unit ?? "min",
      snap,
      status,
      claimTx: claims.find((c) => Number(c.args.policyId) === p.id)?.txHash,
    };
  });
  const sum = (f: (r: Row) => boolean) =>
    rows.filter(f).reduce((a, r) => a + weiToEth(r.payout), 0);
  const claimable = rows.filter((r) => r.status === "claimable");

  const claim = async (r: Row) => {
    await tx.run(`Claim policy #${r.id}`, async () => {
      const c = await getWriteContracts();
      return (c.book as Contract).claim(r.id);
    });
  };
  const claimAll = async () => {
    for (const r of claimable) await claim(r);
  };

  if (!account) {
    return (
      <>
        <PageHeader eyebrow="Cover" title="My policies" />
        <EmptyState
          title="Connect a wallet to see your policies"
          icon="wallet"
          action={
            <Button icon="wallet" onClick={() => void connect().catch(() => undefined)}>
              Connect MetaMask
            </Button>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Cover"
        title="My policies"
        subtitle="Each policy pays its full payout when the evidence puts the true value at or above your threshold."
        actions={
          claimable.length > 1 ? (
            <Button
              variant="pay"
              icon="arrowDown"
              loading={tx.state === "awaiting" || tx.state === "pending"}
              onClick={() => void claimAll()}
            >
              Claim all ({claimable.length})
            </Button>
          ) : undefined
        }
      />
      {tx.state === "reverted" ? (
        <Banner tone="danger" title="Claim reverted">
          {tx.data.reason} <span className="ties-mono">{tx.data.raw}</span>
        </Banner>
      ) : null}
      <div className="ties-row" style={{ alignItems: "stretch", gap: 16 }}>
        <StatTile
          label="Active cover"
          value={
            <Amount
              value={sum((r) => ["bound", "awaiting", "held", "disputed"].includes(r.status))}
              unit={false}
            />
          }
          unit="ETH"
          icon="shield"
        />
        <StatTile
          label="Claimable now"
          tone="pay"
          value={<Amount value={sum((r) => r.status === "claimable")} unit={false} />}
          unit="ETH"
          icon="arrowDown"
        />
        <StatTile
          label="Paid out"
          value={<Amount value={sum((r) => r.status === "claimed")} unit={false} />}
          unit="ETH"
          icon="check"
        />
        <StatTile
          label="Held"
          tone="held"
          value={<Amount value={sum((r) => r.status === "held")} unit={false} />}
          unit="ETH"
          icon="lock"
        />
      </div>
      <DataTable<Row>
        caption="My policies"
        loading={policies === null}
        rows={rows}
        empty={
          <EmptyState
            title="No policies yet"
            body="Browse events to buy your first cover."
            action={<Button onClick={() => nav("/markets")}>Browse events</Button>}
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
          { title: "Threshold", num: true, render: (r) => `≥ ${r.bucket} ${r.unit}` },
          { title: "Payout", num: true, render: (r) => <Amount value={weiToEth(r.payout)} /> },
          {
            title: "Premium paid",
            num: true,
            render: (r) => <Amount value={weiToEth(r.premium)} />,
          },
          {
            title: "Threshold vs interval",
            render: (r) => (
              <IntervalBar
                min={0}
                max={Math.max(1, (r.snap?.bucketCount ?? 721) - 1)}
                threshold={r.bucket}
                L={r.snap?.hasInterval ? r.snap.lower : undefined}
                U={r.snap?.hasInterval ? (r.snap.upper ?? r.snap.bucketCount ?? 721) : undefined}
              />
            ),
          },
          { title: "Status", render: (r) => <StatusChip status={r.status} /> },
          {
            title: "",
            render: (r) =>
              r.status === "claimable" ? (
                <Button size="sm" variant="pay" onClick={() => void claim(r)}>
                  Claim {weiToEth(r.payout).toFixed(4)} ETH
                </Button>
              ) : r.claimTx ? (
                <TxHash hash={r.claimTx} network={info.key} />
              ) : null,
          },
        ]}
      />
    </>
  );
}
