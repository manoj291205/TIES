import { Suspense, lazy, useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell, Banner, Button, EmptyState, PageHeader, TxToast, TxTray } from "./components";
import {
  ChainProvider,
  LogsProvider,
  TxProvider,
  useContracts,
  useNetwork,
  useRoles,
  useTxStore,
  useWallet,
} from "./hooks";
import { weiToEth } from "./lib/format";
// The component gallery holds sample values; it is loaded only in development builds.
const Gallery = import.meta.env.DEV
  ? lazy(() => import("./screens/Gallery").then((m) => ({ default: m.Gallery })))
  : () => null;
import { Landing } from "./screens/Landing";
import { Vault } from "./screens/Vault";
import { TxLog } from "./screens/TxLog";
import { Docs } from "./screens/Docs";
import { Lab } from "./screens/Lab";
import { Presenter } from "./screens/Presenter";
import { Operator } from "./screens/Operator";
import { Admin } from "./screens/Admin";
import { Disputes } from "./screens/Disputes";
import { Marketplace } from "./screens/Marketplace";
import { Explorer } from "./screens/Explorer";
import { Buy } from "./screens/Buy";
import { Policies } from "./screens/Policies";

type Theme = "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("ties.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* storage unavailable */
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("ties.theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "light" ? "dark" : "light"))];
}

/** Placeholder for screens built in later milestones. */
function Pending({ title }: { title: string }) {
  return (
    <>
      <PageHeader eyebrow="Coming next" title={title} />
      <EmptyState
        title="This screen is built in a later milestone"
        body="The foundation (wallet, network, contracts, transactions) is ready for it."
      />
    </>
  );
}

const ROUTES: [string, string][] = [
  ["markets", "Events"],
  ["buy", "Buy cover"],
  ["policies", "My policies"],
  ["explorer", "Settlement explorer"],
  ["log", "Transaction log"],
  ["vault", "Vault"],
  ["operator", "Operator console"],
  ["admin", "Registry & params"],
  ["disputes", "Disputes"],
  ["lab", "Live demo lab"],
  ["presenter", "Presenter"],
  ["docs", "Docs & FAQ"],
];

function Layout() {
  const [theme, toggleTheme] = useTheme();
  const location = useLocation();
  const wallet = useWallet();
  const net = useNetwork();
  const { deployment } = useContracts();
  const { roles, role, setRole } = useRoles();
  const store = useTxStore();
  const [trayOpen, setTrayOpen] = useState(false);
  const [connectState, setConnectState] = useState<"idle" | "pending" | "failed">("idle");
  const active = location.pathname.split("/")[1] || "markets";
  const pending = store.items.filter((i) => i.state === "pending" || i.state === "awaiting").length;
  const wrongChain = wallet.walletChainId != null && net.status === "wrong";

  const contracts = deployment
    ? [
        ["Engine", deployment.addresses.engine],
        ["PolicyBook", deployment.addresses.book],
        ["Vault", deployment.addresses.vault],
        ["Registry", deployment.addresses.registry],
      ].map(([name, address]) => ({ name, address }))
    : [];

  return (
    <AppShell
      active={active === "__components" ? "" : active}
      network={net.status}
      chainId={wrongChain ? (wallet.walletChainId ?? undefined) : net.chainId}
      account={wallet.account}
      balance={weiToEth(wallet.balanceWei)}
      roles={roles}
      role={role}
      onRoleChange={setRole}
      block={net.block?.number}
      blockStatus={net.blockStatus}
      blockAgo={net.blockAgo}
      pending={pending}
      onPendingClick={() => setTrayOpen((o) => !o)}
      onConnect={() => {
        setConnectState("pending");
        wallet
          .connect()
          .then(() => setConnectState("idle"))
          .catch(() => setConnectState("failed"));
      }}
      contracts={contracts}
      headerExtra={
        <Button size="sm" variant="ghost" icon="sliders" onClick={toggleTheme}>
          {theme === "light" ? "Dark" : "Light"}
        </Button>
      }
      overlay={
        <div className="app-overlay">
          <div className="app-toasts">
            {store.toasts.map((t) => (
              <TxToast
                key={t.id}
                title={t.title}
                state={t.state}
                hash={t.hash}
                block={t.block}
                gas={t.gas}
                text={t.text}
                network={net.info.key}
                onDismiss={() => store.dismiss(t.id)}
              />
            ))}
          </div>
          {trayOpen ? <TxTray items={store.items} network={net.info.key} /> : null}
        </div>
      }
    >
      {!wallet.hasWallet ? (
        <Banner
          tone="info"
          title="MetaMask was not found in this browser"
          actions={
            <a
              className="ties-btn ties-btn--secondary ties-btn--sm"
              href="https://metamask.io/download/"
              target="_blank"
              rel="noreferrer"
            >
              Get MetaMask
            </a>
          }
        >
          You can still browse every event and settlement; connecting a wallet is needed only to
          send transactions.
        </Banner>
      ) : null}
      {connectState === "pending" ? (
        <Banner tone="info" title="Open MetaMask to continue">
          A connection request is waiting in your wallet.
        </Banner>
      ) : null}
      {connectState === "failed" ? (
        <Banner
          tone="held"
          title="The wallet did not connect"
          actions={
            <Button size="sm" onClick={() => setConnectState("idle")}>
              Dismiss
            </Button>
          }
        >
          The request was declined or is already open in MetaMask.
        </Banner>
      ) : null}
      {net.status === "unreachable" ? (
        <Banner tone="danger" title="The network could not be reached">
          Retrying automatically. RPC: <code>{net.info.rpcUrl}</code>
        </Banner>
      ) : null}
      {wrongChain ? (
        <Banner
          tone="danger"
          title="Your wallet is on an unsupported network"
          actions={
            <Button
              size="sm"
              onClick={() => void net.switchNetwork(net.chainId).catch(() => undefined)}
            >
              Switch to {net.info.name}
            </Button>
          }
        >
          TIES runs on Hardhat Localhost (31337) and Sepolia (11155111).
        </Banner>
      ) : null}
      {!deployment ? (
        <Banner tone="held" title={`No contracts deployed on ${net.info.name}`}>
          On localhost, start the stack with <code>npm run dev:stack</code>.
        </Banner>
      ) : null}
      <Routes>
        <Route path="/" element={<Landing />} />
        {import.meta.env.DEV ? (
          <Route
            path="/__components"
            element={
              <Suspense fallback={null}>
                <Gallery />
              </Suspense>
            }
          />
        ) : null}
        <Route path="/markets" element={<Marketplace />} />
        <Route path="/explorer" element={<Explorer />} />
        <Route path="/explorer/:id" element={<Explorer />} />
        <Route path="/buy" element={<Buy />} />
        <Route path="/buy/:id" element={<Buy />} />
        <Route path="/policies" element={<Policies />} />
        <Route path="/vault" element={<Vault />} />
        <Route path="/log" element={<TxLog />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/lab" element={<Lab />} />
        <Route path="/presenter" element={<Presenter />} />
        <Route path="/operator" element={<Operator />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/disputes" element={<Disputes />} />
        {ROUTES.filter(
          ([id]) =>
            ![
              "markets",
              "explorer",
              "buy",
              "policies",
              "vault",
              "log",
              "docs",
              "operator",
              "admin",
              "disputes",
            ].includes(id),
        ).map(([id, title]) => (
          <Route key={id} path={`/${id}/*`} element={<Pending title={title} />} />
        ))}
        <Route path="*" element={<Navigate to="/markets" replace />} />
      </Routes>
    </AppShell>
  );
}

export function App() {
  return (
    <ChainProvider>
      <TxProvider>
        <LogsProvider>
          <HashRouter>
            <Layout />
          </HashRouter>
        </LogsProvider>
      </TxProvider>
    </ChainProvider>
  );
}
