import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { BrowserProvider, JsonRpcProvider, JsonRpcSigner, Network as EthersNetwork } from "ethers";
import type { Network } from "../components";
import { Deployment, TiesContracts, connectContracts, getDeployment } from "../lib/contracts";
import {
  NETWORKS,
  NetworkInfo,
  SUPPORTED_CHAIN_IDS,
  addChainParams,
  networkOf,
  toHexChainId,
} from "../lib/networks";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export interface BlockInfo {
  number: number;
  /** Block timestamp (the chain's clock, not the browser's). */
  timestamp: number;
  /** Browser time at which this block was first seen. */
  seenAt: number;
}

export type NetworkStatus = Network | "wrong" | "unreachable";

export interface ChainState {
  hasWallet: boolean;
  account: string | null;
  balanceWei: bigint;
  /** Chain the wallet is on (null when not connected). */
  walletChainId: number | null;
  /** Chain the app reads from. */
  chainId: number;
  info: NetworkInfo;
  status: NetworkStatus;
  rpcOk: boolean;
  block: BlockInfo | null;
  blockStatus: "live" | "stale";
  blockAgo: string;
  deployment: Deployment | null;
  readProvider: JsonRpcProvider;
  /** Contracts bound to the read provider; null when nothing is deployed on this chain. */
  read: TiesContracts | null;
  connect: () => Promise<void>;
  switchNetwork: (chainId: number) => Promise<void>;
  /** A signer from MetaMask, or throws when no wallet is connected. */
  getSigner: () => Promise<JsonRpcSigner>;
  /** Contracts bound to the wallet's signer, for writes. */
  getWriteContracts: () => Promise<TiesContracts>;
}

const ChainContext = createContext<ChainState | null>(null);

const STORE_KEY = "ties.chain";
const readStored = (): number | null => {
  try {
    const v = Number(localStorage.getItem(STORE_KEY));
    return SUPPORTED_CHAIN_IDS.includes(v) ? v : null;
  } catch {
    return null;
  }
};

/** Ask the wallet to switch to `target`, adding the network first when the wallet does not know it. */
async function requestChain(eth: Eip1193, target: number): Promise<void> {
  const next = networkOf(target);
  if (!next) throw new Error(`Chain ${target} is not supported.`);
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHexChainId(target) }],
    });
  } catch (err) {
    const e = err as { code?: number; data?: { originalError?: { code?: number } } };
    // 4902: unknown chain (MetaMask on mobile wraps it in -32603).
    if (e.code === 4902 || e.code === -32603 || e.data?.originalError?.code === 4902) {
      await eth.request({ method: "wallet_addEthereumChain", params: [addChainParams(next)] });
    } else {
      throw err;
    }
  }
}

function agoText(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

export function ChainProvider({ children }: { children: ReactNode }) {
  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  const [account, setAccount] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [preferred, setPreferred] = useState<number>(readStored() ?? 31337);
  const [block, setBlock] = useState<BlockInfo | null>(null);
  const [rpcOk, setRpcOk] = useState(true);
  const [balanceWei, setBalanceWei] = useState(0n);
  const [now, setNow] = useState(Date.now());

  // The app follows the wallet when it is on a supported chain, else the stored preference.
  const chainId = walletChainId != null && NETWORKS[walletChainId] ? walletChainId : preferred;
  const info = NETWORKS[chainId];

  const readProvider = useMemo(
    () =>
      new JsonRpcProvider(info.rpcUrl, chainId, {
        staticNetwork: EthersNetwork.from(chainId),
        batchMaxCount: 1,
        cacheTimeout: -1,
        pollingInterval: info.key === "local" ? 1000 : 4000,
      }),
    [chainId, info.rpcUrl, info.key],
  );

  // Wallet: restore an already-approved connection and follow account and chain changes.
  useEffect(() => {
    if (!eth) return;
    let alive = true;
    void (async () => {
      try {
        const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
        const chain = (await eth.request({ method: "eth_chainId" })) as string;
        if (!alive) return;
        setAccount(accounts[0] ?? null);
        setWalletChainId(accounts[0] ? Number(chain) : null);
      } catch {
        /* no wallet access yet */
      }
    })();
    const onAccounts = (accounts: string[]) => {
      setAccount(accounts[0] ?? null);
      if (!accounts[0]) setWalletChainId(null);
    };
    const onChain = (hex: string) => setWalletChainId(Number(hex));
    eth.on?.("accountsChanged", onAccounts as never);
    eth.on?.("chainChanged", onChain as never);
    return () => {
      alive = false;
      eth.removeListener?.("accountsChanged", onAccounts as never);
      eth.removeListener?.("chainChanged", onChain as never);
    };
  }, [eth]);

  // One poll drives everything that follows the chain: the latest block and the balance.
  useEffect(() => {
    let alive = true;
    let last = -1;
    const tick = async () => {
      try {
        const b = await readProvider.getBlock("latest");
        if (!alive || !b) return;
        setRpcOk(true);
        if (b.number !== last) {
          last = b.number;
          setBlock({ number: b.number, timestamp: b.timestamp, seenAt: Date.now() });
        }
      } catch {
        if (alive) setRpcOk(false);
      }
    };
    setBlock(null);
    void tick();
    const id = window.setInterval(() => void tick(), info.key === "local" ? 1000 : 4000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [readProvider, info.key]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!account || !block) {
      setBalanceWei(0n);
      return;
    }
    let alive = true;
    readProvider
      .getBalance(account)
      .then((v) => alive && setBalanceWei(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [account, block?.number, readProvider]);

  const deployment = useMemo(() => getDeployment(chainId), [chainId]);
  const read = useMemo(
    () => (deployment ? connectContracts(deployment, readProvider) : null),
    [deployment, readProvider],
  );

  const connect = useCallback(async () => {
    if (!eth) throw new Error("MetaMask was not found in this browser.");
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    let chain = Number((await eth.request({ method: "eth_chainId" })) as string);
    setAccount(accounts[0] ?? null);
    setWalletChainId(chain);
    // Put the wallet on the network the app is showing, adding the network if MetaMask lacks it.
    if (chain !== preferred) {
      try {
        await requestChain(eth, preferred);
        chain = Number((await eth.request({ method: "eth_chainId" })) as string);
        setWalletChainId(chain);
      } catch {
        /* declined: the wrong-network banner offers the switch again */
      }
    }
  }, [eth, preferred]);

  const switchNetwork = useCallback(
    async (target: number) => {
      const next = networkOf(target);
      if (!next) throw new Error(`Chain ${target} is not supported.`);
      setPreferred(target);
      try {
        localStorage.setItem(STORE_KEY, String(target));
      } catch {
        /* storage unavailable */
      }
      if (!eth || !account) return;
      await requestChain(eth, target);
    },
    [eth, account],
  );

  const getSigner = useCallback(async () => {
    if (!eth || !account) throw new Error("Connect MetaMask first.");
    return new BrowserProvider(eth as never).getSigner();
  }, [eth, account]);

  const getWriteContracts = useCallback(async () => {
    if (!deployment) throw new Error("No contracts are deployed on this network.");
    return connectContracts(deployment, await getSigner());
  }, [deployment, getSigner]);

  const walletWrong = walletChainId != null && !NETWORKS[walletChainId];
  const status: NetworkStatus = walletWrong ? "wrong" : !rpcOk ? "unreachable" : info.key;
  const sinceBlock = block ? now - block.seenAt : 0;
  // A local automine chain only produces blocks on transactions, so silence there is normal.
  const stale = !rpcOk || (info.key === "sepolia" && block != null && sinceBlock > 60_000);

  const value: ChainState = {
    hasWallet: Boolean(eth),
    account,
    balanceWei,
    walletChainId,
    chainId,
    info,
    status,
    rpcOk,
    block,
    blockStatus: stale ? "stale" : "live",
    blockAgo: agoText(sinceBlock),
    deployment,
    readProvider,
    read,
    connect,
    switchNetwork,
    getSigner,
    getWriteContracts,
  };
  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>;
}

function useChain(): ChainState {
  const ctx = useContext(ChainContext);
  if (!ctx) throw new Error("ChainProvider is missing");
  return ctx;
}

/** Wallet connection: account, balance, connect. Follows accountsChanged without a reload. */
export function useWallet() {
  const c = useChain();
  return {
    hasWallet: c.hasWallet,
    account: c.account,
    balanceWei: c.balanceWei,
    walletChainId: c.walletChainId,
    connect: c.connect,
    getSigner: c.getSigner,
  };
}

/** The selected network, its status, and the live block. Follows chainChanged without a reload. */
export function useNetwork() {
  const c = useChain();
  return {
    chainId: c.chainId,
    info: c.info,
    status: c.status,
    rpcOk: c.rpcOk,
    block: c.block,
    blockStatus: c.blockStatus,
    blockAgo: c.blockAgo,
    walletChainId: c.walletChainId,
    switchNetwork: c.switchNetwork,
    readProvider: c.readProvider,
  };
}

/** Contracts for the selected network (reads) and a factory for signer-bound ones (writes). */
export function useContracts() {
  const c = useChain();
  return {
    deployment: c.deployment,
    read: c.read,
    getWriteContracts: c.getWriteContracts,
  };
}

/** Latest block timestamp, ticking each second between blocks (for countdowns). */
export function useChainClock(): number {
  const { block } = useNetwork();
  const [, setTick] = useState(0);
  const anchor = useRef<{ ts: number; at: number } | null>(null);
  if (block && (!anchor.current || anchor.current.ts !== block.timestamp)) {
    anchor.current = { ts: block.timestamp, at: Date.now() };
  }
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!anchor.current) return Math.floor(Date.now() / 1000);
  return anchor.current.ts; // block time only: countdowns follow the chain, not the browser
}
