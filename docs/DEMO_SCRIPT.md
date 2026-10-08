# Demo script (about 7 minutes)

A live walk-through on the local chain with MetaMask, with the oracles visible in a terminal. The
full guide to every screen and the setup is [DEMO_GUIDE.md](DEMO_GUIDE.md).

## Before the audience arrives

1. Three terminals: `npm run dev:stack`, then `npm run dev:web`, then `npm run watch -- --oracles`.
   Put the browser (http://localhost:5173) and the watch terminal side by side.
2. MetaMask: click **Connect MetaMask** on the website and approve adding and switching to
   "Hardhat Localhost" (chain id 31337, currency ETH; test ETH only).
3. Accounts. `npm run accounts` prints these with their private keys; import them in MetaMask
   (Import account). The keys are public, so use them on the local chain only:

   | MetaMask name | Account | Used for                                |
   | ------------- | ------- | --------------------------------------- |
   | Admin         | #0      | registry, creating events, disputes     |
   | LP            | #1      | vault deposits and withdrawals          |
   | Holder        | #4      | buying cover and claiming               |
   | Challenger    | #18     | optional: challenging a pending default |

   For the LP and Holder steps your own MetaMask account also works: press **Fund my wallet
   (100 ETH)** on the Presenter screen.

4. Presenter screen: **Reset and redeploy** (fresh deploy and seed; the page reloads), then **Fund
   accounts**. In MetaMask use Settings › Advanced › Clear activity tab data for each account
   after a reset, or nonces will be stale.
5. Check on the Presenter screen that the keeper shows **Running** and the oracle nodes are honest.

## Script

| Time | Account | Screen              | What to do and say                                                                                                                                              |
| ---- | ------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | -       | Landing             | Live stats come from the chain. Flight and rainfall events, policies at different thresholds, one shared vault.                                                 |
| 0:40 | Admin   | Registry & params   | The category parameters, the nine registered sources with their signer keys and tool hashes, and the oracle keys. Two keys read S2: they count as one source.   |
| 1:20 | LP      | Vault               | Deposit 20 ETH. Point at free, locked and claimable. Withdrawals are capped at free liquidity.                                                                  |
| 1:50 | Holder  | Buy cover           | AI 101, threshold 120 minutes, payout 1 ETH. The quote comes from the contract; the histogram shows existing cover and the capacity meter. Confirm in MetaMask. |
| 2:30 | Holder  | Buy cover           | Type a payout of 50: the refusal is explained before MetaMask opens.                                                                                            |
| 2:50 | -       | Presenter           | Select AI 101, press **Past observation window**. In the terminal: round 1 opens with its committee and each oracle's next nonce.                               |
| 3:20 | -       | Terminal            | NODE lines: each oracle node calls its source over MCP and commits; the value stays hidden.                                                                     |
| 3:40 | -       | Presenter           | **Past commit deadline**: reveals arrive, each with the source recovered from the signature. **Past reveal deadline**: the keeper closes the round.             |
| 4:10 | -       | Settlement explorer | The interval [L, U] and consensus V. Cover below L turns green (pay), above U grey (released), inside stays held, all in one transaction.                       |
| 4:50 | Holder  | My policies         | Claim the paying policy: one transaction, the ETH arrives in MetaMask.                                                                                          |
| 5:20 | LP      | Vault               | The split moved: released collateral is free again, premiums raised the share value.                                                                            |
| 5:50 | Admin   | Live demo lab       | Run **Compromised feed**: S2 is 90 minutes off and read by two keys; they count as one source and are outvoted. Then the comparison with the four baselines.    |
| 7:00 | -       | -                   | Questions.                                                                                                                                                      |

## Optional extras

- **Forged report** in the lab: the tampering node's reveal reverts on chain; the terminal shows
  `✘ reverted` with the reason.
- A dispute: on an event in a pending default, switch to the Challenger account and press
  **Challenge (0.05 ETH bond)** in the Settlement explorer, then as Admin resolve it on the
  **Disputes** screen.
- Settle by hand: **Pause keeper** on the Presenter screen, then use **Open round 1** and
  **Settle now** in the explorer; **Resume keeper** afterwards.
- Transaction log: every transaction of the session with decoded events and gas.

## If something goes wrong

- MetaMask reports a nonce problem or a transaction hangs after a reset: clear the account's
  activity tab data (step 4). The website says so when it detects it.
- Buy cover refuses because of the per-event limit: deposit more as the LP (an event can take a
  quarter of the free liquidity).
- Nothing happens after advancing time: check on the Presenter screen that the keeper is
  **Running** and the nodes are running in honest mode.
- The page shows "No contracts deployed": the stack is still deploying; wait for the `init`
  process to finish.
