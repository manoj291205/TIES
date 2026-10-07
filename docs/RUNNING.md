# Running TIES

## Requirements

- Node.js 22 (`nvm use` reads `.nvmrc`)
- npm 10+
- Internet access only for the `real-weather` scenario (Open-Meteo, no API key)

## Install and check

```bash
npm install
npm run lint
npm run compile
npm test
npm run build
```

`npm test` includes an integration test that starts the real services against a separate Hardhat
node on port 8599, so it can run while the dev stack is up.

## The local stack

One command starts a Hardhat node, deploys and seeds the contracts, and starts the nine sources,
the oracle nodes, the keeper and the demo server:

```bash
npm run dev:stack
```

| Process     | Address                             | What it does                                                                        |
| ----------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| node        | http://127.0.0.1:8545 (chain 31337) | Hardhat node. Set `HARDHAT_LOGGING=true` for request logging.                       |
| init        | -                                   | Deploys, exports ABIs, registers sources and oracles, seeds demo state, then exits. |
| sources     | 7101-7109                           | Signed upstream sources S1-S9 (`/mcp`, `/control`, `/truth`).                       |
| oracles     | http://127.0.0.1:7200/status        | Oracle nodes on keys #10-#17 (MCP client, commit, reveal).                          |
| keeper      | -                                   | Opens rounds, finalizes rounds, applies defaults.                                   |
| demo server | http://127.0.0.1:7000               | Presenter API (REST and server-sent events), chain 31337 only.                      |

`npm run dev:stack` compiles the contracts first. Stop everything with Ctrl+C.

Deployment addresses are written to `frontend/src/contracts/deployments/31337.json` (not committed)
and the ABIs to `frontend/src/contracts/abi/`. The services re-read that file, so `POST /reset` on
the demo server redeploys without restarting anything.

### Accounts

Hardhat's standard development accounts (publicly known keys, local use only):

| Accounts | Role                              |
| -------- | --------------------------------- |
| #0       | admin / deployer                  |
| #1-#3    | liquidity providers (10 ETH each) |
| #4-#8    | policyholders                     |
| #9       | keeper                            |
| #10-#17  | oracle nodes                      |
| #18      | challenger                        |
| #19      | spare                             |

Source signer keys are generated on first use and kept in `services/.keys/sources.json`
(gitignored).

### Sources

| Id  | Name                  | Category | Data                                            |
| --- | --------------------- | -------- | ----------------------------------------------- |
| S1  | Airline status API    | flight   | mock                                            |
| S2  | Aggregator A          | flight   | mock                                            |
| S3  | Aggregator B          | flight   | mock                                            |
| S4  | ADS-B network         | flight   | mock                                            |
| S5  | Airport FIDS          | flight   | mock                                            |
| S6  | Ops feed              | flight   | mock                                            |
| S7  | Open-Meteo archive    | rain     | real (`archive-api.open-meteo.com`)             |
| S8  | Local weather station | rain     | mock (replays the archive when no truth is set) |
| S9  | Satellite estimate    | rain     | mock (see note below)                           |

Mock sources read ground truth from `services/sources/truth.json` (or `PUT /truth`) and add
deterministic Gaussian noise (sigma 2 to 4 minutes for flights, 1 to 1.5 mm for rain). Each source
exposes `POST /control {mode: "honest" | "offset", offset, sigma, delayMs, down}`.

Rain has three sources, not two: with the default dependence prior (0.2) two distinct sources give
N_eff = 1.67, below the minimum of 1.8, so a rainfall event could never settle on its own.

### Oracle nodes

`services/oracle-node/nodes.json` maps keys to sources. Keys #10 and #11 serve two categories
(flight and rain); key #16 is a second key on S2, which reproduces the "two keys, one feed" case.

| Node | Key | Category | Source | Round-1 committee by default |
| ---- | --- | -------- | ------ | ---------------------------- |
| n1   | #10 | flight   | S1     | yes                          |
| n2   | #11 | flight   | S2     | yes                          |
| n3   | #12 | flight   | S3     | yes                          |
| n4   | #13 | flight   | S4     | no (recruited on escalation) |
| n5   | #14 | flight   | S5     | no                           |
| n6   | #15 | flight   | S6     | no                           |
| n7   | #16 | flight   | S2     | no (second key on S2)        |
| n8   | #17 | rain     | S7     | yes                          |
| n9   | #10 | rain     | S8     | yes                          |
| n10  | #11 | rain     | S9     | yes                          |

Modes: `honest`, `tamper` (changes the value after the source signed it, so the reveal reverts),
`silent` (commits, never reveals), `late` (reveals after the deadline).

```bash
curl http://127.0.0.1:7200/status
curl -X POST http://127.0.0.1:7200/nodes/n2/mode -H "content-type: application/json" -d '{"mode":"tamper"}'
```

### Demo server

| Method and path                | What it does                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| `GET /health`, `/state`        | Liveness, deployment, chain time and block.                       |
| `GET /accounts`                | Role to address map for the presenter.                            |
| `POST /reset`                  | Redeploy and seed.                                                |
| `POST /seed`                   | Add the demo events again.                                        |
| `POST /time/advance {seconds}` | `evm_increaseTime` then `evm_mine`.                               |
| `POST /mine {blocks}`          | Mine blocks.                                                      |
| `POST /sources/:id/mode`       | Proxy to a source's `/control` (id `S2` or `2`).                  |
| `POST /nodes/:id/mode`         | Set an oracle node mode. `/nodes/:id/start` and `/stop` too.      |
| `GET /scenarios`               | Scenario list.                                                    |
| `POST /scenarios/:name/run`    | Runs a scenario; streams steps, transactions and rounds over SSE. |
| `GET /experiments/latest`      | Experiment results (available once the experiments exist).        |

### Scenarios from the command line

With the stack running:

```bash
npm run demo:cli -- --list
npm run demo:cli -- --scenario compromised-feed
```

Each run creates a fresh event, sets the sources and oracle nodes up, binds policies, advances
time, lets the oracle nodes and the keeper do their work, and prints every transaction with its
gas, every round with V, sigma, N_eff, [L, U] and the cursors, and the final decision of each
policy against the ground truth. The exit code is 0 when the scenario met its expectations.

Scenarios: `honest`, `compromised-feed`, `two-keys-one-feed`, `noisy-source`, `late-source`,
`silent-source`, `unavailable-source`, `borderline`, `forged-report`, `inconsistent-rounds`,
`challenged-default`, `real-weather`. Definitions live in `experiments/scenarios.ts`.

Notes:

- The demo events created by the seed stay open in the background. As time advances the keeper and
  oracle nodes work on them too, and their windows may be skipped; that is normal for a demo chain.
- A scenario tops up the vault from LP #1 when its policies would not fit under the per-event cap
  (a quarter of the free liquidity).
- `borderline` ends with policies settled by default and can settle a policy one minute from the
  truth the wrong way; that is the real behaviour, not a failure.

## Configuration

Copy `.env.example` to `.env` only when deploying to a public network. Local development needs no
secrets. Never commit `.env`. Environment variables the local services understand:

| Variable                  | Default                 | Meaning                             |
| ------------------------- | ----------------------- | ----------------------------------- |
| `RPC_URL`                 | `http://127.0.0.1:8545` | JSON-RPC endpoint                   |
| `CHAIN_ID`                | `31337`                 | Chain of the deployment file        |
| `TIES_DEPLOYMENTS_DIR`    | frontend deployments    | Where `<chainId>.json` is read from |
| `OPEN_METEO_ARCHIVE_URL`  | Open-Meteo archive      | Override for tests                  |
| `OPEN_METEO_FORECAST_URL` | Open-Meteo forecast     | Fallback for very recent dates      |

## Web app

```bash
npm run dev:web
```

Opens on http://localhost:5173. It reads the deployment file and ABIs written by the stack, so
start `npm run dev:stack` first. `npm run build` produces a static build in `frontend/dist`
(do not host it publicly).

MetaMask setup for the local chain:

1. Add the network: RPC `http://127.0.0.1:8545`, chain id 31337, currency ETH. The app asks
   MetaMask to add and switch to it when you connect.
2. Import the accounts you need (see the table above) from the private keys the `node` process
   prints at start-up. They are Hardhat's public development keys; never use them elsewhere.
3. After `POST /reset` or the Presenter's Reset, clear each account's activity tab data in
   MetaMask (Settings > Advanced), or it will reuse stale nonces.

The Presenter screen (localhost only) resets, funds accounts, advances time and switches source
and node modes. The Live demo lab runs scenarios and the experiments. A seven-minute script is in
[DEMO_SCRIPT.md](DEMO_SCRIPT.md).

## Experiments

```bash
npm run experiments
npm run experiments:charts
npm run experiments:report
```

The first command runs every scenario against TIES and the four baselines on an in-process Hardhat
network (several minutes); the next two render `docs/figures/` and `docs/EXPERIMENTS.md`.

## Static analysis

With Python 3 and `pip install slither-analyzer`:

```bash
slither . --filter-paths "node_modules|contracts/mocks"
```

Results and their assessment are in [SECURITY.md](SECURITY.md).
