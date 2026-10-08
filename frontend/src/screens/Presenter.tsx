import { useEffect, useState } from "react";
import {
  Address,
  Banner,
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  SegmentedControl,
  StatusChip,
  TextField,
} from "../components";
import { useChainClock, useNetwork, useWallet } from "../hooks";
import { useEventState } from "../hooks/data";
import { useEventList } from "../hooks/events";
import { demoGet, demoPost } from "../lib/demo";

interface Account {
  index: number;
  role: string;
  address: string;
}
interface SourceRow {
  id: number;
  key: string;
  name: string;
  mode?: string;
  offset?: number;
  sigma?: number;
  down?: boolean;
  unreachable?: boolean;
}
interface NodeRow {
  id: string;
  account: number;
  category: number;
  sourceId: number;
  mode: string;
  running: boolean;
  address: string;
}

/** The demo script, with the MetaMask account to use at each step. */
const SCRIPT: [string, string][] = [
  ["admin / deployer", "Admin: show the parameters and the source registry"],
  ["liquidity provider", "Vault: deposit liquidity"],
  ["policyholder", "Buy cover on an event; show the capacity error"],
  ["presenter", "Fast-forward past the observation window"],
  ["oracle node", "Start the oracle nodes: round 1 shows insufficient evidence and the escalation"],
  ["policyholder", "My policies: claim what settled"],
  ["liquidity provider", "Vault: the free, locked and claimable split moved"],
  ["admin / deployer", "Demo lab: run a scenario and the baseline comparison"],
];

/** Presenter control panel (localhost only). */
export function Presenter() {
  const { info, block } = useNetwork();
  const { account } = useWallet();
  const now = useChainClock();
  const { events } = useEventList();
  const [eventId, setEventId] = useState<number | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [keeper, setKeeper] = useState<{ paused: boolean } | null>(null);
  const [seconds, setSeconds] = useState("300");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const selected = eventId ?? events?.[events.length - 1]?.id ?? null;
  const { view } = useEventState(selected);
  const row = events?.find((e) => e.id === selected);

  useEffect(() => {
    demoGet<Account[]>("/accounts")
      .then(setAccounts)
      .catch((e) =>
        setErr(`The demo server is not reachable: ${e instanceof Error ? e.message : e}`),
      );
  }, []);
  useEffect(() => {
    demoGet<SourceRow[]>("/sources")
      .then(setSources)
      .catch(() => undefined);
    demoGet<{ nodes: NodeRow[] }>("/nodes")
      .then((s) => setNodes(s.nodes))
      .catch(() => undefined);
    demoGet<{ paused: boolean }>("/keeper")
      .then(setKeeper)
      .catch(() => setKeeper(null));
  }, [tick, block?.number]);

  if (info.key !== "local")
    return (
      <EmptyState title="Local network only" body="The presenter panel is hidden on Sepolia." />
    );

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setErr(null);
    setMsg(`${label}…`);
    try {
      await fn();
      setMsg(`${label}: done`);
    } catch (e) {
      setMsg(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
    setTick((t) => t + 1);
  };
  const advance = (s: number) =>
    act(`Advance ${s}s`, () => demoPost("/time/advance", { seconds: Math.max(1, Math.ceil(s)) }));
  const toTarget = (target: number | undefined) => (target ? advance(target - now + 1) : undefined);
  const activeRole = accounts.find(
    (a) => a.address.toLowerCase() === (account ?? "").toLowerCase(),
  )?.role;

  return (
    <>
      <PageHeader
        eyebrow="Demo"
        title="Presenter control panel"
        subtitle="Local chain only. Block time is shown so time jumps are visible."
        meta={
          <span className="ties-mono">
            block #{block?.number ?? "…"} · chain time{" "}
            {block ? new Date(block.timestamp * 1000).toLocaleTimeString() : "…"}
          </span>
        }
      />
      {err ? (
        <Banner tone="danger" title="Problem">
          {err}
        </Banner>
      ) : null}
      {msg ? <Banner tone="info" title={msg} /> : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
          gap: 24,
          alignItems: "start",
        }}
      >
        <div className="ties-stack">
          <Panel title="Stack" icon="refresh">
            <div className="ties-row">
              <Button
                variant="danger"
                onClick={() =>
                  void act("Reset and redeploy", async () => {
                    await demoPost("/reset");
                    // New contract addresses: reload so every screen reads the new deployment.
                    window.location.reload();
                  })
                }
              >
                Reset and redeploy
              </Button>
              <Button
                variant="secondary"
                onClick={() => void act("Seed demo events", () => demoPost("/seed"))}
              >
                Seed demo events
              </Button>
              <Button
                variant="secondary"
                onClick={() => void act("Fund accounts", () => demoPost("/fund"))}
              >
                Fund accounts (10,000 ETH)
              </Button>
              <Button
                variant="secondary"
                disabled={!account}
                onClick={() =>
                  void act("Fund my wallet", () => demoPost("/fund", { address: account }))
                }
              >
                Fund my wallet (100 ETH)
              </Button>
            </div>
            <p className="ties-field__hint">
              Reset redeploys the contracts and reloads this page. In MetaMask, clear each
              account&apos;s activity tab data afterwards (Settings › Advanced).
            </p>
          </Panel>
          <Panel
            title="Keeper"
            icon="bolt"
            badge={
              keeper ? (
                <StatusChip
                  status={keeper.paused ? "held" : "confirmed"}
                  label={keeper.paused ? "Paused" : "Running"}
                />
              ) : (
                <StatusChip status="stopped" label="Unreachable" />
              )
            }
          >
            <p className="ties-muted" style={{ margin: 0 }}>
              The keeper opens rounds, finalizes them and applies defaults when they are due. Pause
              it to press those buttons yourself in the Settlement explorer.
            </p>
            <div className="ties-row" style={{ marginTop: 12 }}>
              <Button
                variant="secondary"
                disabled={!keeper}
                onClick={() =>
                  void act(keeper?.paused ? "Resume keeper" : "Pause keeper", () =>
                    demoPost(keeper?.paused ? "/keeper/resume" : "/keeper/pause"),
                  )
                }
              >
                {keeper?.paused ? "Resume keeper" : "Pause keeper"}
              </Button>
            </div>
          </Panel>
          <Panel title="Time" icon="clock">
            <SegmentedControl
              label="Event"
              value={String(selected ?? "")}
              onChange={(v) => setEventId(Number(v))}
              options={(events ?? [])
                .slice(-6)
                .map((e) => ({ value: String(e.id), label: `#${e.id}` }))}
            />
            <p className="ties-subtle" style={{ margin: "8px 0" }}>
              {row?.label ?? "No event"} · {view?.status ?? "—"}
            </p>
            <div className="ties-row">
              <Button
                size="sm"
                variant="secondary"
                disabled={!row}
                onClick={() => void toTarget(row?.cutoff)}
              >
                Past binding cutoff
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!row}
                onClick={() => void toTarget(row?.observationEnd)}
              >
                Past observation window
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!view?.commitDeadline}
                onClick={() => void toTarget(view?.commitDeadline)}
              >
                Past commit deadline
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!view?.revealDeadline}
                onClick={() => void toTarget(view?.revealDeadline)}
              >
                Past reveal deadline
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!view?.challengeDeadline}
                onClick={() => void toTarget(view?.challengeDeadline)}
              >
                Past challenge period
              </Button>
            </div>
            <div className="ties-row" style={{ marginTop: 12, alignItems: "flex-end" }}>
              <TextField
                label="Seconds"
                mono
                value={seconds}
                onChange={setSeconds}
                style={{ width: 140 }}
              />
              <Button size="sm" onClick={() => void advance(Number(seconds))}>
                Advance
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void act("Mine a block", () => demoPost("/mine", { blocks: 1 }))}
              >
                Mine block
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void act("Mine 10 blocks", () => demoPost("/mine", { blocks: 10 }))}
              >
                Mine 10
              </Button>
            </div>
          </Panel>
          <Panel title="Sources" icon="server">
            <DataTable<SourceRow>
              caption="Sources"
              rows={sources}
              columns={[
                { title: "Source", render: (r) => `${r.key} · ${r.name}` },
                {
                  title: "State",
                  render: (r) =>
                    r.unreachable ? (
                      <StatusChip status="stopped" label="Unreachable" />
                    ) : r.down ? (
                      <StatusChip status="reverted" label="Down" />
                    ) : r.mode === "offset" ? (
                      <StatusChip status="compromised" label={`+${r.offset}`} />
                    ) : (
                      <StatusChip status="honest" label={`Honest σ ${r.sigma}`} />
                    ),
                },
                {
                  title: "",
                  render: (r) => (
                    <span className="ties-row">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void act(`${r.key} honest`, () =>
                            demoPost(`/sources/${r.key}/mode`, {
                              mode: "honest",
                              offset: 0,
                              down: false,
                            }),
                          )
                        }
                      >
                        Honest
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void act(`${r.key} +90`, () =>
                            demoPost(`/sources/${r.key}/mode`, {
                              mode: "offset",
                              offset: 90,
                              down: false,
                            }),
                          )
                        }
                      >
                        +90
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void act(`${r.key} down`, () =>
                            demoPost(`/sources/${r.key}/mode`, { down: true }),
                          )
                        }
                      >
                        Down
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          </Panel>
        </div>
        <div className="ties-stack">
          <Panel title="Oracle nodes" icon="user">
            <DataTable<NodeRow>
              caption="Oracle nodes"
              rows={nodes}
              columns={[
                { title: "Node", render: (r) => `${r.id} · S${r.sourceId}` },
                { title: "Key", render: (r) => <Address value={r.address} /> },
                {
                  title: "Mode",
                  render: (r) => (
                    <StatusChip
                      status={r.mode === "honest" ? "honest" : "compromised"}
                      label={r.mode}
                    />
                  ),
                },
                {
                  title: "",
                  render: (r) => (
                    <span className="ties-row">
                      {(["honest", "tamper", "silent", "late"] as const).map((m) => (
                        <Button
                          key={m}
                          size="sm"
                          variant={r.mode === m ? "secondary" : "ghost"}
                          onClick={() =>
                            void act(`${r.id} ${m}`, () =>
                              demoPost(`/nodes/${r.id}/mode`, { mode: m }),
                            )
                          }
                        >
                          {m}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void act(`${r.id} ${r.running ? "stop" : "start"}`, () =>
                            demoPost(`/nodes/${r.id}/${r.running ? "stop" : "start"}`),
                          )
                        }
                      >
                        {r.running ? "Stop" : "Start"}
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          </Panel>
          <Panel title="Demo script and accounts" icon="presenter">
            <p className="ties-subtle" style={{ marginTop: 0 }}>
              Connected account: {account ? `${activeRole ?? "unknown account"}` : "none"}
            </p>
            <ol style={{ paddingLeft: 20, margin: 0 }}>
              {SCRIPT.map(([role, text], i) => (
                <li
                  key={i}
                  style={{
                    padding: "4px 0",
                    fontWeight: role === activeRole ? 600 : 400,
                    background: role === activeRole ? "var(--info-wash)" : undefined,
                  }}
                >
                  <span className="ties-chip ties-chip--outline" style={{ marginRight: 8 }}>
                    {role}
                  </span>
                  {text}
                </li>
              ))}
            </ol>
            <div style={{ marginTop: 12 }}>
              <DataTable<Account>
                caption="Accounts"
                rows={accounts}
                columns={[
                  { title: "#", num: true, key: "index" },
                  { title: "Role", key: "role" },
                  { title: "Address", render: (r) => <Address value={r.address} /> },
                ]}
              />
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
