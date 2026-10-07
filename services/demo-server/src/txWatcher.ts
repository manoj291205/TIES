import { Interface, JsonRpcProvider } from "ethers";
import { ACCOUNTS, Deployment, hardhatAccount, loadAbi, type ContractName } from "../../shared/src";

export interface TxRecord {
  block: number;
  hash: string;
  from: string;
  role: string;
  contract: string;
  method: string;
  status: "mined" | "reverted";
  gasUsed: string;
}

const roleOf = (() => {
  const roles = new Map<string, string>();
  const add = (index: number, name: string) =>
    roles.set(hardhatAccount(index).address.toLowerCase(), name);
  add(ACCOUNTS.admin, "admin #0");
  ACCOUNTS.lps.forEach((i) => add(i, `LP #${i}`));
  ACCOUNTS.holders.forEach((i) => add(i, `holder #${i}`));
  add(ACCOUNTS.keeper, "keeper #9");
  ACCOUNTS.oracles.forEach((i) => add(i, `oracle #${i}`));
  add(ACCOUNTS.challenger, "challenger #18");
  return (address: string) => roles.get(address.toLowerCase()) ?? address.slice(0, 10);
})();

/** Follows new blocks and describes every transaction (who called what, did it revert, gas). */
export class TxWatcher {
  readonly records: TxRecord[] = [];
  private next: number;
  private readonly byAddress = new Map<string, { name: string; iface: Interface }>();

  constructor(
    private readonly provider: JsonRpcProvider,
    deployment: Deployment,
    fromBlock: number,
  ) {
    this.next = fromBlock;
    const add = (address: string, name: ContractName) =>
      this.byAddress.set(address.toLowerCase(), {
        name,
        iface: new Interface(loadAbi(name) as never),
      });
    add(deployment.addresses.engine, "SettlementEngine");
    add(deployment.addresses.book, "PolicyBook");
    add(deployment.addresses.vault, "Vault");
    add(deployment.addresses.registry, "TIESRegistry");
  }

  private chain: Promise<unknown> = Promise.resolve();

  /** Reads blocks mined since the last call; returns the new transactions. */
  poll(): Promise<TxRecord[]> {
    const run = this.chain.then(() => this.readNewBlocks());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async readNewBlocks(): Promise<TxRecord[]> {
    const head = await this.provider.getBlockNumber();
    const fresh: TxRecord[] = [];
    while (this.next <= head) {
      const block = await this.provider.getBlock(this.next, false);
      this.next += 1;
      if (!block) continue;
      for (const hash of block.transactions) {
        const tx = await this.provider.getTransaction(hash);
        const receipt = await this.provider.getTransactionReceipt(hash);
        if (!tx || !receipt) continue;
        const target = tx.to ? this.byAddress.get(tx.to.toLowerCase()) : undefined;
        let method = "transfer";
        if (target) {
          try {
            method =
              target.iface.parseTransaction({ data: tx.data, value: tx.value })?.name ?? "call";
          } catch {
            method = "call";
          }
        }
        fresh.push({
          block: block.number,
          hash,
          from: tx.from,
          role: roleOf(tx.from),
          contract: target?.name ?? "other",
          method,
          status: receipt.status === 1 ? "mined" : "reverted",
          gasUsed: receipt.gasUsed.toString(),
        });
      }
    }
    this.records.push(...fresh);
    return fresh;
  }
}
