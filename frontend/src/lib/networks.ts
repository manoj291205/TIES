import type { Network } from "../components";

export interface NetworkInfo {
  chainId: number;
  key: Network;
  name: string;
  rpcUrl: string;
  /** Block explorer base URL; null on localhost (the in-app log is used instead). */
  explorer: string | null;
  currency: { name: string; symbol: string; decimals: number };
}

const ETH = { name: "Ether", symbol: "ETH", decimals: 18 };

export const NETWORKS: Record<number, NetworkInfo> = {
  31337: {
    chainId: 31337,
    key: "local",
    name: "Hardhat Localhost",
    rpcUrl: "http://127.0.0.1:8545",
    explorer: null,
    currency: ETH,
  },
  11155111: {
    chainId: 11155111,
    key: "sepolia",
    name: "Sepolia",
    rpcUrl:
      (import.meta.env.VITE_SEPOLIA_RPC_URL as string | undefined) ??
      "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    currency: { ...ETH, name: "Sepolia Ether", symbol: "SEP" },
  },
};

export const SUPPORTED_CHAIN_IDS = Object.keys(NETWORKS).map(Number);

export const toHexChainId = (chainId: number) => `0x${chainId.toString(16)}`;

export function networkOf(chainId: number | null | undefined): NetworkInfo | null {
  return chainId == null ? null : (NETWORKS[chainId] ?? null);
}

/** Parameters for `wallet_addEthereumChain`. */
export function addChainParams(info: NetworkInfo) {
  return {
    chainId: toHexChainId(info.chainId),
    chainName: info.name,
    nativeCurrency: info.currency,
    rpcUrls: [info.rpcUrl],
    blockExplorerUrls: info.explorer ? [info.explorer] : undefined,
  };
}
