import type { CSSProperties, ReactNode } from "react";
import { fmtEth, fmtInt } from "../lib/format";
import { Button } from "./Controls";
import { Address, Network } from "./Display";
import { Icon, IconName, Spinner } from "./Icon";

const NETS: Record<Network, { name: string; id: string; color: string }> = {
  local: { name: "Hardhat Localhost", id: "31337", color: "var(--net-local)" },
  sepolia: { name: "Sepolia", id: "11155111", color: "var(--net-sepolia)" },
};

export interface NetworkChipProps {
  network: Network | "wrong" | "unreachable";
  chainId?: number | string;
}

export function NetworkChip({ network, chainId }: NetworkChipProps) {
  if (network === "wrong") {
    return (
      <span className="ties-netchip ties-netchip--wrong">
        <Icon name="alert" size={14} />
        Wrong network · {chainId ?? "?"}
      </span>
    );
  }
  if (network === "unreachable") {
    return (
      <span className="ties-netchip ties-netchip--wrong">
        <Icon name="x" size={14} />
        RPC unreachable
      </span>
    );
  }
  const n = NETS[network];
  return (
    <span className="ties-netchip" title={`Chain id ${n.id}`}>
      <span className="ties-dot" style={{ background: n.color }} />
      {n.name}
      <span className="ties-mono ties-subtle" style={{ fontSize: 12 }}>
        · {n.id}
      </span>
    </span>
  );
}

export interface WalletChipProps {
  address: string;
  balance: number;
  label?: string;
}

export function WalletChip({ address, balance, label }: WalletChipProps) {
  return (
    <span className="ties-wallet">
      <span className="ties-wallet__bal">
        {fmtEth(balance, 4)}
        <span className="ties-subtle" style={{ fontSize: 11, marginLeft: 4 }}>
          ETH
        </span>
      </span>
      <span className="ties-wallet__sep" />
      <Address value={address} />
      {label ? (
        <span className="ties-chip ties-chip--outline" style={{ height: 20 }}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

export type RoleName = "Policyholder" | "LP" | "Operator" | "Admin" | "Presenter";
const ROLE_ICON: Record<RoleName, IconName> = {
  Policyholder: "shield",
  LP: "vault",
  Operator: "server",
  Admin: "key",
  Presenter: "presenter",
};

export interface RoleSwitcherProps {
  roles: RoleName[];
  active?: RoleName;
  onChange?: (role: RoleName) => void;
}

export function RoleSwitcher({ roles, active, onChange }: RoleSwitcherProps) {
  const current = active ?? roles[0];
  return (
    <div className="ties-roles" role="group" aria-label="Roles held by this account">
      {roles.map((r) => (
        <button key={r} type="button" aria-pressed={current === r} onClick={() => onChange?.(r)}>
          <Icon name={ROLE_ICON[r]} size={13} />
          {r}
        </button>
      ))}
    </div>
  );
}

export interface LiveBlockProps {
  block?: number;
  status?: "live" | "stale";
  ago?: string;
}

export function LiveBlock({ block, status = "live", ago }: LiveBlockProps) {
  if (status === "stale") {
    return (
      <span className="ties-live" style={{ color: "var(--danger-ink)" }}>
        <span className="ties-dot" style={{ background: "var(--danger)", boxShadow: "none" }} />
        No new block · {ago ?? "45s"}
      </span>
    );
  }
  return (
    <span className="ties-live" title="Latest block">
      <span className="ties-dot ties-pulse" />
      Live · {block == null ? "…" : `#${fmtInt(block)}`}
    </span>
  );
}

interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  /** Role required to see the item; "local" means localhost only. */
  need: RoleName | "local" | null;
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Cover",
    items: [
      { id: "markets", label: "Events", icon: "grid", need: null },
      { id: "buy", label: "Buy cover", icon: "plus", need: "Policyholder" },
      { id: "policies", label: "My policies", icon: "shield", need: "Policyholder" },
    ],
  },
  {
    group: "Settlement",
    items: [
      { id: "explorer", label: "Settlement explorer", icon: "target", need: null },
      { id: "log", label: "Transaction log", icon: "list", need: null },
    ],
  },
  { group: "Liquidity", items: [{ id: "vault", label: "Vault", icon: "vault", need: "LP" }] },
  {
    group: "Oracle",
    items: [{ id: "operator", label: "Operator console", icon: "server", need: "Operator" }],
  },
  {
    group: "Admin",
    items: [
      { id: "admin", label: "Registry & params", icon: "key", need: "Admin" },
      { id: "disputes", label: "Disputes", icon: "flag", need: "Admin" },
    ],
  },
  {
    group: "Demo",
    items: [
      { id: "lab", label: "Live demo lab", icon: "beaker", need: "local" },
      { id: "presenter", label: "Presenter", icon: "presenter", need: "local" },
    ],
  },
  { group: "Help", items: [{ id: "docs", label: "Docs & FAQ", icon: "book", need: null }] },
];

export interface ShellContract {
  name: string;
  address: string;
}

export interface AppShellProps {
  /** Id of the active route (see NAV). */
  active: string;
  network?: Network | "wrong" | "unreachable";
  chainId?: number | string;
  /** Connected account, or null when no wallet is connected. */
  account?: string | null;
  balance?: number;
  roles?: RoleName[];
  role?: RoleName;
  onRoleChange?: (role: RoleName) => void;
  block?: number;
  blockStatus?: "live" | "stale";
  blockAgo?: string;
  pending?: number;
  onPendingClick?: () => void;
  onConnect?: () => void;
  counts?: Record<string, number>;
  /** Extra header content, e.g. the theme toggle. */
  headerExtra?: ReactNode;
  /** Deployed contract addresses shown at the bottom of the nav. */
  contracts?: ShellContract[];
  overlay?: ReactNode;
  height?: number;
  style?: CSSProperties;
  mainStyle?: CSSProperties;
  children?: ReactNode;
}

/** Header, role-filtered left nav and the main column. */
export function AppShell({
  active,
  network = "local",
  chainId,
  account,
  balance = 0,
  roles = ["Policyholder", "LP", "Operator", "Admin", "Presenter"],
  role,
  onRoleChange,
  block,
  blockStatus,
  blockAgo,
  pending,
  onPendingClick,
  onConnect,
  counts = {},
  headerExtra,
  contracts = [],
  overlay,
  height,
  style,
  mainStyle,
  children,
}: AppShellProps) {
  const isLocal = network === "local";
  return (
    <div className="ties ties-app" style={{ minHeight: height ?? "100vh", ...style }}>
      <header className="ties-header">
        <div className="ties-brand">
          <b>TIES</b>
          <span>Evidence-interval settlement</span>
        </div>
        <div className="ties-header__spacer" />
        {headerExtra ?? null}
        <LiveBlock block={block} status={blockStatus} ago={blockAgo} />
        <NetworkChip network={network} chainId={chainId} />
        {account ? <RoleSwitcher roles={roles} active={role} onChange={onRoleChange} /> : null}
        {pending ? (
          <button
            className="ties-btn ties-btn--secondary ties-btn--sm"
            type="button"
            aria-label={`${pending} pending transactions`}
            onClick={onPendingClick}
          >
            <Spinner size={14} />
            <span className="ties-mono">{pending} pending</span>
          </button>
        ) : null}
        {account ? (
          <WalletChip address={account} balance={balance} />
        ) : (
          <Button size="sm" icon="wallet" onClick={onConnect}>
            Connect MetaMask
          </Button>
        )}
      </header>
      <nav className="ties-side" aria-label="Main">
        {NAV.map((g) => {
          const items = g.items.filter((it) => {
            if (!it.need) return true;
            if (it.need === "local") return isLocal;
            return roles.includes(it.need);
          });
          if (!items.length) return null;
          return (
            <div key={g.group} className="ties-nav">
              <div className="ties-label ties-nav__group">{g.group}</div>
              {items.map((it) => (
                <a
                  key={it.id}
                  href={`#/${it.id}`}
                  aria-current={active === it.id ? "page" : undefined}
                >
                  <Icon name={it.icon} />
                  {it.label}
                  {counts[it.id] != null ? (
                    <span className="ties-nav__count">{counts[it.id]}</span>
                  ) : null}
                </a>
              ))}
            </div>
          );
        })}
        {contracts.length ? (
          <div style={{ marginTop: "auto" }} className="ties-subtle">
            <div className="ties-label" style={{ marginBottom: 6 }}>
              Contracts
            </div>
            <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
              {contracts.map((c) => (
                <div key={c.name} className="ties-row" style={{ justifyContent: "space-between" }}>
                  <span>{c.name}</span>
                  <Address value={c.address} copy={false} />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </nav>
      <main className="ties-main" style={mainStyle}>
        {children}
      </main>
      {overlay ?? null}
    </div>
  );
}

export interface PageHeaderProps {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, subtitle, meta, actions }: PageHeaderProps) {
  return (
    <div className="ties-pagehead">
      <div style={{ minWidth: 0 }}>
        {eyebrow ? <div className="ties-label">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
        {meta ? (
          <div className="ties-row" style={{ marginTop: 10 }}>
            {meta}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="ties-row" style={{ flex: "none" }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
