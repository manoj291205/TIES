import { useEffect, useState } from "react";
import type { Contract } from "ethers";
import {
  Amount,
  Banner,
  Button,
  EmptyState,
  KeyValue,
  PageHeader,
  Panel,
  StatusChip,
  TextField,
  TxFlow,
} from "../components";
import { useChainClock, useContracts, useNetwork, useTx, useWallet } from "../hooks";
import { useEventState, useRoles } from "../hooks/data";
import { EventRow, useEventList } from "../hooks/events";
import { fmtDuration, weiToEth } from "../lib/format";

const REASON = ["Inconsistent evidence", "Challenged default", "Evidence never became sufficient"];

function DisputeCard({ row }: { row: EventRow }) {
  const { read, getWriteContracts } = useContracts();
  const { info } = useNetwork();
  const { view } = useEventState(row.id);
  const { admin } = useRoles();
  const now = useChainClock();
  const tx = useTx();
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState<{ pay: bigint; noPay: bigint } | null>(null);
  const [challenger, setChallenger] = useState<{ who: string; bond: bigint } | null>(null);
  const v = Number(value);
  const valid = value !== "" && Number.isFinite(v) && v >= 0;

  useEffect(() => {
    if (!read || !view) return;
    read.engine
      .eventState(row.id)
      .then((st: { challenger: string; bond: bigint }) =>
        setChallenger(st.bond > 0n ? { who: st.challenger, bond: st.bond } : null),
      )
      .catch(() => undefined);
  }, [read, view?.status, row.id]);

  // What each choice would move: collateral between the settled cursors and the chosen value.
  useEffect(() => {
    if (!read || !view || !valid) return setPreview(null);
    let alive = true;
    const b = Math.floor(v);
    void (async () => {
      try {
        const pay = (await read.book.rangeCollateral(row.id, view.payCursor + 1, b)) as bigint;
        const noPay = (await read.book.rangeCollateral(
          row.id,
          b + 1,
          view.noPayCursor - 1,
        )) as bigint;
        if (alive) setPreview({ pay, noPay });
      } catch {
        if (alive) setPreview(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [read, view?.payCursor, view?.noPayCursor, value]);

  if (!view) return null;
  const pending = view.status === "DEFAULT_PENDING";
  return (
    <Panel
      title={row.label}
      icon="flag"
      badge={
        <StatusChip
          status={pending ? "settling" : "disputed"}
          label={pending ? "Default pending" : "Disputed"}
        />
      }
    >
      <KeyValue
        items={[
          [
            "Event",
            <a key="e" className="ties-link" href={`#/explorer/${row.id}`}>
              #{row.id}
            </a>,
          ],
          ["Reason", pending ? "No dispute yet" : REASON[view.disputeReason]],
          ["Held money", <Amount key="h" value={weiToEth(view.held)} />],
          ...(challenger
            ? ([
                [
                  "Challenger bond",
                  <span key="b">
                    <Amount value={weiToEth(challenger.bond)} /> from {challenger.who.slice(0, 8)}…
                  </span>,
                ],
              ] as [string, React.ReactNode][])
            : []),
          ["Last consensus", `${(Number(view.vLast) / 1000).toFixed(1)} ${row.unit}`],
        ]}
      />
      {pending ? (
        <div style={{ marginTop: 12 }}>
          <Button
            disabled={now < view.challengeDeadline}
            onClick={() =>
              void tx.run(`Apply default · event ${row.id}`, async () => {
                const c = (await getWriteContracts()).engine as Contract;
                const gas = (await c.applyDefault.estimateGas(row.id)) as bigint;
                return c.applyDefault(row.id, { gasLimit: (gas * 115n) / 100n });
              })
            }
          >
            Apply default
          </Button>
          <div className="ties-field__hint">
            {now < view.challengeDeadline
              ? `Challenge period ends in ${fmtDuration(view.challengeDeadline - now)}.`
              : "The challenge period is over; anyone can apply the default."}
          </div>
        </div>
      ) : admin ? (
        <div style={{ marginTop: 12 }}>
          <TextField
            label={`Final value (${row.unit})`}
            mono
            value={value}
            onChange={(t) => {
              setValue(t);
              setConfirm(false);
            }}
            hint="Policies at or below this value pay; the rest do not."
          />
          {preview ? (
            <Banner tone="info" title="What this would move" style={{ marginTop: 8 }}>
              <Amount value={weiToEth(preview.pay)} /> becomes claimable and{" "}
              <Amount value={weiToEth(preview.noPay)} /> is released to the vault. Bond handling:
              returned to the challenger only if the value differs from the last consensus by more
              than the error tolerance.
            </Banner>
          ) : null}
          <div style={{ marginTop: 8 }} className="ties-row">
            {confirm ? (
              <Button
                variant="danger"
                disabled={!valid}
                onClick={() =>
                  void tx.run(`Resolve dispute · event ${row.id}`, async () => {
                    const c = (await getWriteContracts()).engine as Contract;
                    const milli = BigInt(Math.round(v * 1000));
                    const gas = (await c.resolveDispute.estimateGas(row.id, milli)) as bigint;
                    return c.resolveDispute(row.id, milli, { gasLimit: (gas * 115n) / 100n });
                  })
                }
              >
                Confirm: resolve at {value} {row.unit}
              </Button>
            ) : (
              <Button disabled={!valid} onClick={() => setConfirm(true)}>
                Resolve
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p className="ties-muted">Only the admin can resolve a dispute.</p>
      )}
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
    </Panel>
  );
}

/** Disputes queue: disputed events and pending defaults. */
export function Disputes() {
  const { events } = useEventList();
  const { account } = useWallet();
  const queue = (events ?? []).filter((e) => e.engineStatus === 3 || e.engineStatus === 4);
  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Disputes"
        subtitle="Events whose evidence was inconsistent, never became sufficient, or whose default was challenged, and defaults waiting for their challenge period."
      />
      {!account ? (
        <Banner tone="info" title="Connect a wallet to act">
          Resolving a dispute needs the admin account.
        </Banner>
      ) : null}
      {queue.length === 0 ? (
        <EmptyState title="No disputes" body="Nothing is waiting for review." />
      ) : (
        queue.map((e) => <DisputeCard key={e.id} row={e} />)
      )}
    </>
  );
}
