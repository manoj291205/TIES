import { useState } from "react";
import type { Contract } from "ethers";
import { parseEther } from "ethers";
import {
  Amount,
  Banner,
  Button,
  DataTable,
  EmptyState,
  KeyValue,
  MoneySplit,
  PageHeader,
  Panel,
  StatTile,
  TextField,
  TxFlow,
  TxHash,
} from "../components";
import { useContracts, useNetwork, useTx, useWallet } from "../hooks";
import { useContractEvents, useVault } from "../hooks/data";
import { useEventList } from "../hooks/events";
import { fmtWei, weiToEth } from "../lib/format";

const ZERO_EXPLAIN = (locked: bigint, claimable: bigint) =>
  `${fmtWei(locked)} ETH is locked as collateral for open policies and ${fmtWei(claimable)} ETH is owed to claimants.`;

/** Liquidity vault: deposit, withdraw, and see why some funds cannot leave yet. */
export function Vault() {
  const { getWriteContracts } = useContracts();
  const { info } = useNetwork();
  const { account, connect } = useWallet();
  const vault = useVault();
  const { events } = useEventList();
  const history = useContractEvents(["Deposit", "Withdraw"]);
  const dep = useTx();
  const wd = useTx();
  const [depositText, setDepositText] = useState("1");
  const [withdrawText, setWithdrawText] = useState("1");

  const parse = (t: string): { v: bigint | null; err?: string } => {
    try {
      const v = parseEther(t || "0");
      return v > 0n ? { v } : { v: null, err: "Enter an amount greater than zero." };
    } catch {
      return { v: null, err: "Enter an amount in ETH, e.g. 1.5" };
    }
  };
  const d = parse(depositText);
  const w = parse(withdrawText);
  const over = vault && w.v !== null && w.v > vault.maxWithdraw;

  const exposure = (events ?? [])
    .filter((e) => e.locked > 0n)
    .map((e) => ({
      id: e.id,
      label: e.label,
      category: e.kind === "flight" ? "Flight delay" : "Rainfall",
      locked: e.locked,
    }));
  const byCategory = exposure.reduce<Record<string, bigint>>(
    (a, e) => ({ ...a, [e.category]: (a[e.category] ?? 0n) + e.locked }),
    {},
  );

  if (!vault)
    return <EmptyState title="No vault on this network" body="Nothing is deployed here yet." />;
  const total = weiToEth(vault.totalAssets);
  const util =
    total > 0
      ? Math.round((weiToEth(vault.locked) / (total + weiToEth(vault.claimable))) * 100)
      : 0;

  return (
    <>
      <PageHeader
        eyebrow="Liquidity"
        title="Vault"
        subtitle="Premiums earned by the vault belong to liquidity providers. Funds locked behind open policies, and funds owed to claimants, cannot be withdrawn."
      />
      <div className="ties-row" style={{ alignItems: "stretch", gap: 16 }}>
        <StatTile label="Total assets" value={fmtWei(vault.totalAssets)} unit="ETH" icon="vault" />
        <StatTile label="Free" value={fmtWei(vault.free)} unit="ETH" />
        <StatTile label="Locked" tone="held" value={fmtWei(vault.locked)} unit="ETH" icon="lock" />
        <StatTile
          label="Claimable"
          tone="pay"
          value={fmtWei(vault.claimable)}
          unit="ETH"
          icon="arrowDown"
        />
        <StatTile label="Utilization" value={`${util}%`} sub="locked ÷ (assets + claimable)" />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 380px",
          gap: 24,
          alignItems: "start",
        }}
      >
        <div className="ties-stack">
          <Panel title="Where the money is" icon="vault">
            <MoneySplit
              title="Vault balance"
              segments={[
                { key: "free", value: weiToEth(vault.free) },
                { key: "locked", value: weiToEth(vault.locked) },
                { key: "claimable", value: weiToEth(vault.claimable) },
              ]}
            />
          </Panel>
          <Panel
            title="Exposure by event"
            icon="layers"
            badge={
              <span className="ties-subtle" style={{ fontSize: 12 }}>
                {Object.entries(byCategory)
                  .map(([k, v]) => `${k} ${fmtWei(v)} ETH`)
                  .join(" · ")}
              </span>
            }
          >
            <DataTable
              caption="Exposure by event"
              rows={exposure}
              empty={
                <EmptyState
                  title="No cover is open"
                  body="Collateral appears here while policies are open."
                />
              }
              columns={[
                {
                  title: "Event",
                  render: (r) => (
                    <a className="ties-link" href={`#/explorer/${r.id}`}>
                      {r.label}
                    </a>
                  ),
                },
                { title: "Category", key: "category" },
                {
                  title: "Locked",
                  num: true,
                  render: (r) => <Amount value={weiToEth(r.locked)} />,
                },
              ]}
            />
          </Panel>
          <Panel title="History" icon="list">
            <DataTable
              caption="Vault history"
              rows={[...history].reverse().slice(0, 30)}
              empty={<EmptyState title="No deposits or withdrawals yet" />}
              columns={[
                { title: "Block", num: true, render: (r) => `#${r.block}` },
                { title: "Event", key: "name" },
                {
                  title: "LP",
                  render: (r) => String(r.args.lp).slice(0, 6) + "…" + String(r.args.lp).slice(-4),
                },
                {
                  title: "Amount",
                  num: true,
                  render: (r) => <Amount value={weiToEth(r.args.assets as bigint)} />,
                },
                { title: "Tx", render: (r) => <TxHash hash={r.txHash} network={info.key} /> },
              ]}
            />
          </Panel>
        </div>
        <div className="ties-stack">
          <Panel title="Your position" icon="user">
            {account ? (
              <KeyValue
                items={[
                  ["Shares", vault.shares.toString()],
                  ["Withdrawable now", <b key="w">{fmtWei(vault.maxWithdraw)} ETH</b>],
                ]}
              />
            ) : (
              <Button icon="wallet" block onClick={() => void connect().catch(() => undefined)}>
                Connect MetaMask
              </Button>
            )}
          </Panel>
          <Panel title="Deposit" icon="arrowDown">
            <TextField
              label="Amount"
              value={depositText}
              onChange={setDepositText}
              suffix="ETH"
              mono
              error={d.err}
            />
            <div style={{ marginTop: 12 }}>
              <Button
                block
                disabled={!account || d.v === null}
                loading={dep.state === "awaiting" || dep.state === "pending"}
                onClick={() =>
                  void dep.run(`Deposit ${depositText} ETH`, async () =>
                    ((await getWriteContracts()).vault as Contract).deposit({ value: d.v }),
                  )
                }
              >
                Deposit
              </Button>
            </div>
            {dep.state !== "idle" ? (
              <div style={{ marginTop: 12 }}>
                <TxFlow
                  state={dep.state}
                  hash={dep.data.hash}
                  block={dep.data.block}
                  gas={dep.data.gas}
                  reason={dep.data.reason}
                  raw={dep.data.raw}
                  network={info.key}
                  action="Vault.deposit"
                >
                  <Button size="sm" variant="ghost" onClick={dep.reset}>
                    Dismiss
                  </Button>
                </TxFlow>
              </div>
            ) : null}
          </Panel>
          <Panel title="Withdraw" icon="arrowUp">
            <TextField
              label="Amount"
              value={withdrawText}
              onChange={setWithdrawText}
              suffix="ETH"
              mono
              error={w.err}
              hint={`At most ${fmtWei(vault.maxWithdraw)} ETH right now.`}
            />
            {over ? (
              <Banner tone="held" title="More than you can withdraw now" style={{ marginTop: 8 }}>
                {ZERO_EXPLAIN(vault.locked, vault.claimable)}
              </Banner>
            ) : null}
            <div style={{ marginTop: 12 }}>
              <Button
                variant="secondary"
                block
                disabled={!account || w.v === null || over === true}
                loading={wd.state === "awaiting" || wd.state === "pending"}
                onClick={() =>
                  void wd.run(`Withdraw ${withdrawText} ETH`, async () =>
                    ((await getWriteContracts()).vault as Contract).withdraw(w.v),
                  )
                }
              >
                Withdraw
              </Button>
            </div>
            {wd.state !== "idle" ? (
              <div style={{ marginTop: 12 }}>
                <TxFlow
                  state={wd.state}
                  hash={wd.data.hash}
                  block={wd.data.block}
                  gas={wd.data.gas}
                  reason={wd.data.reason}
                  raw={wd.data.raw}
                  network={info.key}
                  action="Vault.withdraw"
                >
                  <Button size="sm" variant="ghost" onClick={wd.reset}>
                    Dismiss
                  </Button>
                </TxFlow>
              </div>
            ) : null}
          </Panel>
        </div>
      </div>
    </>
  );
}
