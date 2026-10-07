import { Banner, Button, KeyValue, PageHeader, Panel } from "../components";
import { useNetwork } from "../hooks";
import { NETWORKS } from "../lib/networks";

const FAQ: [string, string][] = [
  [
    "What does a policy pay?",
    "Its full payout, if the true value (flight delay in minutes or 24 h rainfall in mm) is at or above your threshold. The premium is quoted by the contract from a published exceedance curve; you cannot choose it.",
  ],
  [
    "Why can a policy stay held?",
    "Evidence is an interval, not a point. Policies whose threshold lies inside the interval cannot be decided yet. If more than the escalation trigger is held, the contract asks sources it has not heard from to report, and the interval narrows.",
  ],
  [
    "What if two oracle keys read the same feed?",
    "They count as one source. The contract derives each report's source from the source's own signature, so a single feed can never settle money alone.",
  ],
  [
    "What happens if the evidence disagrees or never becomes sufficient?",
    "The event is disputed. Nothing already settled reverses, held collateral stays locked, and the admin resolves it. A pending default can also be challenged with a bond.",
  ],
  [
    "Why can I not withdraw all my vault funds?",
    "Funds locked behind open policies and funds owed to claimants are not free. Withdrawals are limited to the free part of your share.",
  ],
];

/** Static docs: add the network to MetaMask, test accounts, how settlement works, FAQ. */
export function Docs() {
  const { switchNetwork } = useNetwork();
  return (
    <>
      <PageHeader
        eyebrow="Help"
        title="Docs & FAQ"
        subtitle="Everything here works without a wallet."
      />
      <Panel title="Add a network to MetaMask" icon="wallet">
        <div className="ties-stack">
          {Object.values(NETWORKS).map((n) => (
            <div key={n.chainId}>
              <KeyValue
                items={[
                  ["Network name", n.name],
                  [
                    "RPC URL",
                    <span key="r" className="ties-mono">
                      {n.rpcUrl}
                    </span>,
                  ],
                  ["Chain id", String(n.chainId)],
                  ["Currency", n.currency.symbol],
                ]}
              />
              <div style={{ marginTop: 8 }}>
                <Button
                  size="sm"
                  icon="plus"
                  onClick={() => void switchNetwork(n.chainId).catch(() => undefined)}
                >
                  Add {n.name} to MetaMask
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Import test accounts (localhost only)" icon="key">
        <p style={{ margin: 0 }}>
          Start the local chain with <code>npm run dev:stack</code>. The Hardhat node prints twenty
          well-known test accounts and their private keys in its terminal. In MetaMask choose Add
          account, then Import account, and paste a key. Account #0 is the admin, #1 to #3 are
          liquidity providers, #4 to #8 are policyholders, #10 to #17 are oracle nodes.
        </p>
        <Banner
          tone="danger"
          title="Never use these keys on a real network"
          style={{ marginTop: 12 }}
        >
          Their keys are public. This app never displays a private key.
        </Banner>
      </Panel>
      <Panel title="Sepolia test ETH" icon="bolt">
        <p style={{ margin: 0 }}>
          Use any Sepolia faucet to fund the account you connect. Sepolia is a public test network
          and is enabled only when contracts are deployed there.
        </p>
      </Panel>
      <Panel title="How settlement works" icon="target">
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            Policies on an event are indexed by threshold, with their collateral locked in the
            vault.
          </li>
          <li>
            After the observation window, oracle nodes commit and then reveal reports. Each report
            carries a signature from its upstream source.
          </li>
          <li>
            The contract turns the reports into a consensus value and an evidence interval [L, U].
            The interval narrows only as independent sources are added.
          </li>
          <li>
            Every policy with a threshold at or below L is settled as paying, and every policy above
            U as not paying, in one transaction, however many policies exist.
          </li>
          <li>
            Policies inside the interval stay held. If enough money is held, new sources are
            recruited and the interval narrows again. Settlement only ever moves forward.
          </li>
        </ol>
      </Panel>
      <Panel title="FAQ" icon="book">
        <div className="ties-stack">
          {FAQ.map(([q, a]) => (
            <div key={q}>
              <b>{q}</b>
              <p className="ties-muted" style={{ margin: "4px 0 0" }}>
                {a}
              </p>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
