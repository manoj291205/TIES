# TIES

Parametric insurance for flight delays and rainfall, running on an EVM chain. You buy cover such
as "pay me 1 ETH if flight AI 101 arrives at least 120 minutes late". Independent data sources
report what happened. The contract turns their reports into an evidence interval and settles every
policy on either side of that interval at once. Nobody files a claim form and nobody approves a
payout by hand.

![Settlement explorer](docs/screenshots/06-explorer.png)

## What it does

- **Buy cover.** Pick an event (a flight on a date, or 24-hour rainfall at a place), a threshold
  and a payout. The contract quotes the premium. The payout is locked in a shared liquidity vault
  the moment the policy is bound.
- **Collect evidence.** After the event, oracle nodes fetch the value from signed upstream sources
  over MCP and submit it with commit and reveal. The contract identifies the source from its
  signature, so several keys reading the same feed count as one source.
- **Settle by interval.** Each round produces a consensus value and an interval whose width
  shrinks as the number of independent sources grows. Cover below the interval pays, cover above
  it is released back to the vault, and only cover inside it waits.
- **Ask for more evidence when it matters.** If too much money is still undecided, the contract
  recruits oracles on sources that have not reported yet. If the evidence conflicts, the event is
  disputed; if rounds run out, a challengeable default applies.
- **Claim.** A holder whose policy paid claims it in one transaction.
- **Provide liquidity.** LPs deposit ETH into the vault, earn the premiums, and can withdraw
  whatever is not locked as collateral.
- **Learn.** After each event, oracle reputation and the learned dependence between sources are
  updated for the next one.

## Screens

|                                                                                                         |                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ![Landing](docs/screenshots/01-landing.png) Landing with live stats                                     | ![Events](docs/screenshots/02-events.png) Events open for cover                                                |
| ![Buy cover](docs/screenshots/03-buy-cover.png) Buy cover: threshold, capacity and the contract's quote | ![Bought](docs/screenshots/04-buy-confirmed.png) The policy confirmed on chain                                 |
| ![Explorer, dark](docs/screenshots/06-explorer-dark.png) Settlement explorer (dark theme)               | ![Pending default](docs/screenshots/05-explorer-default-pending.png) An event waiting for its challenge period |
| ![My policies](docs/screenshots/08-policies-claimed.png) My policies: claim what paid                   | ![Vault](docs/screenshots/09-vault.png) Liquidity vault: free, locked, claimable                               |
| ![Operator](docs/screenshots/10-operator.png) Oracle operator console                                   | ![Admin](docs/screenshots/11-admin.png) Registry and parameters                                                |
| ![Demo lab](docs/screenshots/13-demo-lab.png) Live demo lab and the baseline comparison                 | ![Presenter](docs/screenshots/14-presenter.png) Presenter controls (local chain only)                          |
| ![Transaction log](docs/screenshots/15-transaction-log.png) Every transaction with decoded events       | ![Docs](docs/screenshots/16-docs.png) Docs and FAQ                                                             |

All numbers in these screenshots come from a real run on the local chain: an LP deposit, a cover
purchase, an oracle round, the default and a claim, each a mined transaction.

## How it works

```mermaid
flowchart LR
  UI[Web app<br/>React + MetaMask] -->|bind, claim, deposit| C[Contracts<br/>PolicyBook, Vault,<br/>SettlementEngine, Registry]
  O[Oracle nodes] -->|commit, reveal| C
  K[Keeper] -->|open, finalize, default| C
  O -->|MCP| S[Signed sources S1-S9]
  UI -->|presenter, lab| D[Demo server]
  D --> S
  D --> O
```

- **Contracts** (Solidity 0.8.24): `Vault`, `TIESRegistry`, `PolicyBook` (with a Fenwick tree of
  locked collateral per event), `SettlementEngine`, `SignedAdapterVerifier`, `EscalationPlanner`,
  `LearningModule`. They hold all the money and make every decision.
- **Services** (TypeScript): nine signed data sources (one reads the real Open-Meteo archive), the
  oracle nodes, a keeper that opens and finalizes rounds, and a localhost demo server.
- **Web app** (React, Vite, ethers v6): reads the chain directly and sends every transaction
  through MetaMask.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

You need Node.js 22, npm 10+ and MetaMask in a desktop browser.

```bash
npm install
```

Start the local chain, deploy the contracts and start every service (leave it running):

```bash
npm run dev:stack
```

In a second terminal, start the web app:

```bash
npm run dev:web
```

Optionally, in a third terminal, watch the oracles and every transaction live:

```bash
npm run watch
```

Then:

1. Open http://localhost:5173 and click **Connect MetaMask**. Approve adding and switching to
   **Hardhat Localhost** (chain 31337, RPC `http://127.0.0.1:8545`). The currency is test ETH on
   your machine; nothing costs real money.
2. Either press **Fund my wallet (100 ETH)** on the **Presenter** screen to use your own MetaMask
   account, or import the demo accounts. `npm run accounts` prints them with their private keys:
   #0 admin, #1 liquidity provider, #4 policyholder, #10 oracle. These are Hardhat's public test
   keys; use them only on this local chain.
3. As #1, deposit into the **Vault**. As #4, go to **Events**, pick an event and **Buy cover**.
4. On the **Presenter** screen, advance time past the observation window. The keeper and oracle
   nodes run the rounds; watch them in the **Settlement explorer**.
5. As #4, open **My policies** and claim what paid.

After a reset from the Presenter screen, clear each account's activity in MetaMask
(Settings > Advanced) so it does not reuse old nonces.

[docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md) explains every screen, MetaMask and the terminal view, and
plans a live demo; [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) is a seven-minute cut of it. Scenarios can also run from the command line while the stack is up:

```bash
npm run demo:cli -- --scenario compromised-feed
```

## Checks

```bash
npm run lint
npm test
npm run build
```

`npm test` runs the contract tests (including differential tests against the TypeScript reference
in `packages/ties-math` and an end-to-end test of the services), the reference package tests and
the frontend tests. With the stack and the web app running, `npm run test:e2e` drives every screen
of the website in a browser (see [docs/RUNNING.md](docs/RUNNING.md)).

## Documentation

| Document                                         | Contents                                                     |
| ------------------------------------------------ | ------------------------------------------------------------ |
| [docs/RUNNING.md](docs/RUNNING.md)               | Services, ports, accounts, scenarios, configuration          |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)     | Components, event lifecycle, repository layout               |
| [docs/CONTRACTS.md](docs/CONTRACTS.md)           | Contract API, events, gas and sizes                          |
| [docs/SECURITY.md](docs/SECURITY.md)             | Threat model, edge cases, static analysis                    |
| [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)       | Comparison with baseline designs, generated from runs        |
| [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md)         | Using every screen, MetaMask, the terminal view, a demo plan |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)       | A seven-minute live demo with MetaMask                       |
| [docs/DESIGN_MAPPING.md](docs/DESIGN_MAPPING.md) | Design placeholders mapped to contract calls                 |
| [PROGRESS.md](PROGRESS.md)                       | Milestone log                                                |

## Repository layout

| Path                 | Contents                                                    |
| -------------------- | ----------------------------------------------------------- |
| `contracts/`         | Solidity 0.8.24 contracts                                   |
| `test/`              | Hardhat tests                                               |
| `scripts/`           | Deploy, seed and ABI export scripts, command-line demo      |
| `packages/ties-math` | TypeScript reference implementation of the settlement maths |
| `services/`          | Source servers, oracle nodes, keeper, demo server           |
| `experiments/`       | Scenarios, experiment runner, charts, report                |
| `frontend/`          | React + Vite + TypeScript web app                           |
| `docs/`              | Documentation and screenshots                               |
