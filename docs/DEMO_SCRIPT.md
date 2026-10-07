# Demo script (about 7 minutes)

A live walk-through on the local chain with MetaMask. It follows the steps listed on the Presenter
screen, which shows the same order and the connected account's role.

## Before the audience arrives

1. `npm run dev:stack` in one terminal, `npm run dev:web` in another. Open http://localhost:5173.
2. MetaMask: add the network "Hardhat Localhost" (RPC `http://127.0.0.1:8545`, chain id 31337,
   currency ETH). The app offers to add it when you connect.
3. Import these Hardhat development accounts. The `node` process of `npm run dev:stack` prints
   their private keys when it starts; Docs & FAQ explains the import. The keys are public, so use
   them on the local chain only:

   | MetaMask name | Account | Used for                                |
   | ------------- | ------- | --------------------------------------- |
   | Admin         | #0      | registry, creating events, disputes     |
   | LP            | #1      | vault deposits and withdrawals          |
   | Holder        | #4      | buying cover and claiming               |
   | Challenger    | #18     | optional: challenging a pending default |

4. Presenter screen: **Reset** (fresh deploy and seed), then **Fund accounts**. In MetaMask use
   Settings > Advanced > Clear activity tab data for each account after a reset, or nonces will be
   stale.
5. Leave the oracle nodes running (default). Pick the AI 101 event in the Events list.

## Script

| Time | Account | Screen              | What to do and say                                                                                                                                                          |
| ---- | ------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | -       | Landing             | Live stats come from the chain. One flight event, policies at different delay thresholds, one shared vault.                                                                 |
| 0:40 | Admin   | Registry & params   | The category parameters, the nine registered sources with their signer keys and tool hashes, and the oracle keys. Two keys read S2: they count as one source.               |
| 1:30 | LP      | Vault               | Deposit 5 ETH. Point at free, locked and claimable. Withdrawals are capped at free liquidity.                                                                               |
| 2:10 | Holder  | Buy cover           | AI 101, threshold 120 minutes, payout 1 ETH. The quote comes from the contract; the histogram shows existing cover and the capacity meter. Confirm in MetaMask.             |
| 2:50 | Holder  | Buy cover           | Try a payout that exceeds the window capacity: the revert is decoded into plain language and a nearby bucket is suggested.                                                  |
| 3:20 | -       | Presenter           | Advance time past the observation end. The keeper opens round 1 and the oracle nodes commit and reveal through MCP.                                                         |
| 3:50 | -       | Settlement explorer | Round 1: the reports, grouped by source, the effective number of sources, the interval [L, U]. Cover below L turns green (pay), above U grey (released), inside stays held. |
| 4:40 | -       | Settlement explorer | If held collateral is above the trigger, the escalation panel shows recruits from sources that were not yet represented. Advance time again to play round 2.                |
| 5:20 | Holder  | My policies         | Claim the paying policy: one transaction, the ETH arrives in MetaMask.                                                                                                      |
| 5:50 | LP      | Vault               | The split moved: released collateral is free again, premiums raised the share value.                                                                                        |
| 6:20 | Admin   | Live demo lab       | Run `compromised-feed` live: S2 is offset by 90 minutes and read by two keys. Then the comparison table from the experiments (TIES against the four baselines).             |
| 7:00 | -       | -                   | Questions.                                                                                                                                                                  |

## Optional extras

- `forged-report` in the lab: the tampering node's reveal reverts on chain.
- `challenged-default`: switch to the Challenger account and challenge a pending default on the
  Disputes screen (bond 0.05 ETH), then resolve it as Admin.
- Transaction log: every transaction of the session with decoded events and gas.

## If something goes wrong

- MetaMask says "nonce too high" or a transaction hangs after a reset: clear the account's
  activity tab data (step 4).
- Nothing happens after advancing time: check the Presenter's node list (nodes running, mode
  honest) and that the event's observation window really ended.
- The page shows "No contracts deployed": the stack is still deploying; wait for the `init`
  process to finish.
