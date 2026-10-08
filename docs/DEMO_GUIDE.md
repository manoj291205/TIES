# Using and demonstrating TIES

This guide covers setting up MetaMask, what every screen does, and how to run a live demo with
the terminal view of the oracles next to the browser. The short timed script is in
[DEMO_SCRIPT.md](DEMO_SCRIPT.md).

## 1. Start everything (three terminals)

| Terminal | Command             | What it is                                                                     |
| -------- | ------------------- | ------------------------------------------------------------------------------ |
| 1        | `npm run dev:stack` | Local chain, contracts, the nine data sources, oracle nodes, keeper, demo API. |
| 2        | `npm run dev:web`   | The website at http://localhost:5173.                                          |
| 3        | `npm run watch`     | Live view of the chain: every transaction, oracle step and round result.       |

Wait until terminal 1 shows the `init` process finished (about 20 to 30 seconds) before opening
the website. `npm run watch -- --oracles` shows only the oracle rounds, which is the clearest view
during a talk.

## 2. MetaMask

### Currency and network

- The local chain is **Hardhat Localhost**, chain id **31337**, RPC `http://127.0.0.1:8545`.
- The currency is **ETH**. It is test ETH on your own machine and has no value. You do not need
  any token, and you do not need real money or a faucet.
- The first time you click **Connect MetaMask**, the website asks MetaMask to add and switch to
  this network. Approve both pop-ups. (If MetaMask says the RPC URL is already used by another
  network, edit that network in MetaMask and set its chain id to 31337.)

### Which wallet to use

You have two options, and you can mix them:

1. **Your own MetaMask account (simplest).** Connect it, open **Presenter** and press
   **Fund my wallet (100 ETH)**. That account can now deposit into the vault and buy cover.
   No import needed.
2. **The demo accounts (needed for the admin and oracle roles).** The contracts give the admin
   and oracle roles to specific Hardhat accounts. Print them with:

   ```bash
   npm run accounts
   ```

   In MetaMask: account menu › **Add account or hardware wallet** › **Import account**, paste a
   private key. Import these:

   | Account | Role               | Use it for                                    |
   | ------- | ------------------ | --------------------------------------------- |
   | #0      | Admin              | Registry, creating events, resolving disputes |
   | #1      | Liquidity provider | Vault deposits and withdrawals                |
   | #4      | Policyholder       | Buying cover and claiming                     |
   | #10     | Oracle (n1 → S1)   | Operator console, manual commit and reveal    |
   | #18     | Challenger         | Challenging a pending default                 |

   These keys are public test keys. Use them only on the local chain, never on a real network.

### After a restart or reset

MetaMask remembers nonces and blocks from the previous run of the local chain. After restarting
`npm run dev:stack` or pressing **Reset and redeploy**, open MetaMask › **Settings** ›
**Advanced** › **Clear activity tab data** for each account you use. If you forget, the website
tells you to do this when MetaMask reports a nonce problem.

## 3. The screens

The left menu groups the screens by role. The chips at the top show the roles the connected
account holds, read from the contracts.

**Cover**

- **Events**: every insured event (three flights and one rainfall event to start), filterable by
  category and status, with a search box. **Buy cover** on a card opens the purchase.
- **Buy cover**: drag the threshold slider (or use the arrow keys), type a payout, and read the
  premium the contract quotes. The histogram shows cover already bought nearby and the capacity
  meter shows how much more fits. If the payout is too large the reason is shown before MetaMask
  opens. **Buy cover** sends `PolicyBook.bind`.
- **My policies**: your policies with their status (bound, held, claimable, claimed, no pay) and a
  small bar comparing your threshold with the evidence interval. **Claim** pays one policy;
  **Claim all** pays every claimable one.

**Settlement**

- **Settlement explorer**: the main view of one event. The chart shows the money locked at each
  threshold, the evidence interval [L, U] and the consensus V. Green pays, grey is released,
  striped is held. Below it: the rounds, the reports grouped by source (each verified from the
  source signature), the number of independent sources (N_eff) and where the money stands.
  **Open round 1**, **Settle now** and **Apply default** let anyone push the event forward;
  **Challenge** posts the 0.05 ETH bond against a pending default. **View as table** shows the
  chart as a table.
- **Transaction log**: every decoded contract event, newest first, filterable by contract.
  **Event log** in the explorer opens it filtered to one event.

**Liquidity**

- **Vault**: total assets, free, locked and claimable money, your share and what you can withdraw
  now. **Deposit** and **Withdraw**. Withdrawals are limited to money that is not locked.

**Oracle and admin** (shown when the account holds the role)

- **Operator console** (oracle accounts #10 to #17): the source the key reads, its MCP endpoint,
  reputation, and an inbox of rounds. **Fetch and commit** asks the source for a signed report
  and commits to it; **Reveal** opens it after the commit window. The oracle node service does
  the same thing automatically; stop the nodes that use the key on the Presenter screen to do it
  by hand (key #10 is used by n1 and n9, key #11 by n2 and n10).
- **Registry & params** (admin #0): category parameters (saving creates a new version; existing
  events keep theirs), sources and their activation, the oracle allowlist and committee flag,
  and **Create event**.
- **Disputes** (admin #0): disputed events with a preview of what a final value would settle,
  **Resolve**, and pending defaults with **Apply default**.

**Demo** (local chain only)

- **Live demo lab**: pick a scenario (honest, compromised feed, two keys on one feed, noisy,
  late, silent, unavailable, borderline, forged report, inconsistent rounds, challenged
  default) and press **Run**. Every step appears as a mined transaction while the chart
  updates, then the result is checked against what the scenario expects. Below: the comparison
  with four baseline designs from the experiments.
- **Presenter**: **Reset and redeploy**, **Seed demo events**, **Fund accounts**, **Fund my
  wallet**, time jumps to the next deadline of the selected event, **Advance** by seconds,
  **Mine block**, source modes (**Honest**, **+90** minutes, **Down**), oracle node modes
  (honest, tamper, silent, late) with **Stop**/**Start**, and **Pause keeper** /
  **Resume keeper**.
- **Docs & FAQ**: network setup, accounts and how settlement works.

## 4. Reading the terminal view

`npm run watch` prints one block at a time. This excerpt is real output from round 1 of AI 101,
opened by hand from the explorer (abridged: long hashes cut):

```text
── block 107 · chain time 2:17:32 PM ──────────────────────────────
ENGINE holder1 #4 nonce 5  SettlementEngine.openRound(1)  353,521 gas ✔  0x3fab…a006
         round 1 opened for event 1: commit by 2:19:32 PM, reveal by 2:21:32 PM
           committee: oracle n1→S1,n9→S8 #10 next nonce 0 · oracle n2→S2,n10→S9 #11 next nonce 0 · oracle n3→S3 #12 next nonce 0
NODE   n1 (S1 Airline status API) event 1 round 1: committed (value hidden) 136.021
NODE   n2 (S2 Aggregator A) event 1 round 1: committed (value hidden) 135.071
NODE   n3 (S3 Aggregator B) event 1 round 1: committed (value hidden) 132.032
── block 108 · chain time 2:17:33 PM ──────────────────────────────
ORACLE oracle n1→S1,n9→S8 #10 nonce 0  SettlementEngine.commit(1, 1, 0x3888adef65e25170)  53,882 gas ✔  0xcd22…4aae
         commit stored for oracle n1→S1,n9→S8 #10 (event 1, round 1); the value stays hidden until the reveal
   …
── block 112 · chain time 2:19:36 PM ──────────────────────────────
ORACLE oracle n1→S1,n9→S8 #10 nonce 1  SettlementEngine.reveal(1, 1, 136021, …)  164,827 gas ✔  0x4479…51bb
         revealed 136.0 min · source S1 Airline status API recovered from the signature
   …
── block 116 · chain time 2:21:35 PM ──────────────────────────────
ENGINE holder1 #4 nonce 6  SettlementEngine.finalizeRound(1)  541,849 gas ✔  0x7f59…5493
         round 1 VALID: V 134.4 min, σ 2.35, N_eff 2.14, interval [127.8 min, 141.0 min]
           pay up to bucket 127, no pay from 142; newly claimable 3.5 ETH, released 1 ETH, still held 2 ETH
         event 1: no further round; default after 2:26:35 PM unless challenged
```

- **NODE** lines are the oracle node working off chain: calling its source's MCP tool and keeping
  the signed value. **ORACLE** lines are that oracle's transactions on chain, with the sender's
  **nonce** (each account's transaction counter). **ENGINE** lines are settlement calls.
- When a round opens, the committee is listed with each oracle's next nonce, so you can watch
  every key send exactly one commit and one reveal.
- A tampering node's reveal shows `✘ reverted` with the reason; a silent node never reveals.

## 5. Demo plan

### Before the audience arrives

1. Start the three terminals (section 1). Arrange the browser and terminal 3 side by side.
2. On **Presenter**, press **Reset and redeploy**, then **Fund accounts**. Clear MetaMask's
   activity for each account (section 2).
3. Connect MetaMask on the website. Have accounts #0, #1 and #4 imported, or your own account
   funded with **Fund my wallet**.

### The flow (about 10 minutes; DEMO_SCRIPT.md has a 7-minute cut)

| Step | Account   | Screen            | Do                                                       | Point out                                                                                                          |
| ---- | --------- | ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1    | any       | Events            | Show the events.                                         | Flights and rainfall, open for cover.                                                                              |
| 2    | #1 LP     | Vault             | Deposit 20 ETH.                                          | Free, locked and claimable; LPs earn premiums.                                                                     |
| 3    | #4 holder | Buy cover         | AI 101, threshold 120, payout 1 ETH, Buy cover.          | The premium comes from the contract; capacity meter; MetaMask signs; terminal 3 shows `PolicyBound`.               |
| 4    | #4 holder | Buy cover         | Type a payout of 50.                                     | The refusal is explained before anything is sent.                                                                  |
| 5    | any       | Presenter         | Select AI 101 and press **Past observation window**.     | The keeper opens round 1; terminal 3 shows the committee and nonces.                                               |
| 6    | any       | Explorer (AI 101) | Watch the round.                                         | NODE lines: each oracle calls its source over MCP and commits; values stay hidden.                                 |
| 7    | any       | Presenter         | **Past commit deadline**, then **Past reveal deadline**. | Reveals show the source recovered from each signature; the keeper finalizes.                                       |
| 8    | any       | Explorer          | Read the result.                                         | Interval [L, U]; everything below L pays and above U is released in one transaction; only the policy inside waits. |
| 9    | #4 holder | My policies       | Claim.                                                   | One transaction; the ETH arrives in MetaMask.                                                                      |
| 10   | #0 admin  | Live demo lab     | Run **Compromised feed**.                                | Aggregator A is 90 minutes off and read by two keys: they count as one source, so it cannot move money alone.      |
| 11   | #0 admin  | Live demo lab     | Run **Forged report**.                                   | The tampering node's reveal reverts: the signature no longer matches.                                              |
| 12   | any       | Live demo lab     | Scroll to the comparison.                                | TIES against the baselines, from real receipts.                                                                    |

### Optional: settle by hand

On **Presenter** press **Pause keeper**. The explorer then needs you to press **Open round 1**
and **Settle now** yourself, and on a pending default **Apply default**. Stop nodes n1 and n9 (both
send from key #10) and use account #10 in the **Operator console** to **Fetch and commit** and
**Reveal**; start them again afterwards.
Press **Resume keeper** afterwards. (The lab resumes it by itself when you run a scenario.)

### Optional: a dispute

When an event is in a pending default, switch to account #18, press **Challenge (0.05 ETH bond)**
in the explorer, then as #0 open **Disputes**, type a final value, **Resolve** and **Confirm**.
The bond goes back to the challenger if the final value is far enough from the consensus.

## 6. Troubleshooting

| What you see                                                      | Fix                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| "MetaMask's saved history is from an older run…" or a nonce error | MetaMask › Settings › Advanced › Clear activity tab data.                                       |
| "Your wallet is on an unsupported network"                        | Press **Switch to Hardhat Localhost** in the banner.                                            |
| "No contracts deployed"                                           | The stack is still starting; wait for `init` to finish.                                         |
| Buy cover refuses: "above the … the vault allows for one event"   | An event can take a quarter of the free liquidity. Deposit more as the LP.                      |
| Nothing happens after advancing time                              | Check on **Presenter** that the keeper is **Running** and the nodes are running in honest mode. |
| Reset fails right after starting the stack                        | Wait until `init` has finished, then reset again.                                               |
| The rainfall source S7 shows errors                               | S7 reads the real Open-Meteo archive and needs internet; S8 and S9 still work.                  |

## 7. Checking that everything works

With terminals 1 and 2 running:

```bash
npm run test:e2e
```

This resets the local chain and drives every screen in Microsoft Edge (or Chrome with
`E2E_BROWSER=chrome`): wallet connection and network switching, navigation, theme, filters,
vault deposit and withdrawal, buying cover with its checks, opening and settling rounds by hand,
challenge and dispute resolution, defaults, claims, the operator console, the admin registry,
the presenter controls, the transaction log and every lab scenario. It takes about 15 minutes; a
report is written to `e2e-report/`. Set `E2E_FULL=1` to also run the 15-minute experiment run
from the lab.
