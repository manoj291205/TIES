# Security

This document covers the threat model of the contracts and services, the checks done in
Milestone 9, and the static-analysis results. It describes the code in this repository; nothing
here has been audited by a third party.

## Trust model

| Actor                         | Trusted for                                                               | Not trusted for                                      |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| Admin (`DEFAULT_ADMIN_ROLE`)  | Category parameters, source and oracle registry, event creation, disputes | -                                                    |
| Upstream source (signing key) | Signing the value it observed                                             | Being independent of other sources (learned instead) |
| Oracle key                    | Relaying a source report in time                                          | The value, the source id, or showing up at all       |
| Keeper                        | Liveness only (opening rounds, finalizing, applying defaults)             | Anything else: every call is public and re-checked   |
| Policyholder, LP, challenger  | -                                                                         | Everything                                           |

The admin is fully trusted. It can register sources, change parameters for future events, point
the policy book at a different engine and resolve disputes at any value. On a public network the
admin should be a multisig. Category parameters are versioned, so an edit never changes an event
that already exists.

## Threats and mitigations

| Threat                                            | Mitigation                                                                                                                                                                                                                                                                              | Tested in                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Oracle reports a value its source never signed    | The verifier recovers the signer from an EIP-191 signature over the value and metadata; the source id comes from the registry, never from the oracle.                                                                                                                                   | `engine.test.ts` (P6), `verifier.test.ts`                   |
| Report replayed on another chain, engine or event | The signed digest binds `chainId`, the engine address (the verifier uses `msg.sender`) and `eventId`. ECDSA rejects malleable (high-s) signatures.                                                                                                                                      | `verifier.test.ts`                                          |
| Stale or future report                            | `ts` must lie in `[observationEnd - 1 day, now]`.                                                                                                                                                                                                                                       | `verifier.test.ts`                                          |
| Copying another oracle's report                   | Commit then reveal; the commit hash includes the oracle's own address and a salt, so a commit cannot be reused by another key.                                                                                                                                                          | `engine.test.ts`                                            |
| Many keys on one feed inflating the evidence      | Reports from one source count as one (`rho = 1`). N_eff < N_min moves nothing; P1 holds on every path, including the default (an event with no valid interval is disputed, not defaulted).                                                                                              | `engine.test.ts` (P1), `safety.test.ts`                     |
| Compromised source                                | Weighted median and agreement kernel discount outliers; reputation drops after the event; the learned dependence between sources that err together rises.                                                                                                                               | `escalation.test.ts`                                        |
| Commit griefing (commit, never reveal)            | Only committee members may commit, once per round. Unrevealed commits carry no weight and cost the oracle reputation (`beta + 1`). A member that commits and withholds its reveal is never recruited again for the same event, so it cannot spend the round budget and force a dispute. | `engine.test.ts`, `escalation.test.ts`, `edgeCases.test.ts` |
| Unbounded loops                                   | At most 16 reports per event (registry rejects more), at most 64 oracles per category, a held-bucket scan of at most 64 buckets, at most 32 curve points and z values, view ranges of at most 1,024 buckets. No loop runs over policies in settlement.                                  | `engine.test.ts`, `registry.test.ts`                        |
| Starving the learning update to dodge a penalty   | Learning runs in try/catch, but only if 6,000,000 gas remain; with less, the whole transaction reverts.                                                                                                                                                                                 | `safety.test.ts`                                            |
| Learning revert locking an event                  | try/catch emits `LearningSkipped` and settlement continues.                                                                                                                                                                                                                             | `safety.test.ts`                                            |
| Challenger blocking a dispute resolution          | A returned bond is pushed with a 50,000 gas cap after all state changes. If the push fails it is recorded in `bondOwed` and withdrawn with `withdrawBond`.                                                                                                                              | `engine.test.ts`                                            |
| Settled policy reversed                           | Cursors are monotone and clamped; `CursorRegression` asserts it.                                                                                                                                                                                                                        | `engine.test.ts` (P2)                                       |
| LP withdrawing collateral                         | `withdraw` is capped at `min(share value, free liquidity)`; locked and claimable ETH are excluded.                                                                                                                                                                                      | `vault.test.ts` (P5), `edgeCases.test.ts`                   |
| Share inflation by the first depositor            | 1,000 dead shares are minted on the first deposit; deposits that would mint zero shares revert.                                                                                                                                                                                         | `vault.test.ts`                                             |
| Reentrancy                                        | `nonReentrant` on every function that moves ETH (`deposit`, `withdraw`, `payClaim`, `bind`, `claim`, `finalizeRound`, `challenge`, `applyDefault`, `resolveDispute`, `withdrawBond`). State is written before transfers. Vault and book only call trusted contracts.                    | `vault.test.ts`, `policyBook.test.ts`                       |
| Over-exposure of the pool                         | Three capacity checks at binding: a cap per window of nearby buckets, a cap per event as a share of free liquidity, and free liquidity itself.                                                                                                                                          | `policyBook.test.ts`                                        |
| Contract size limit                               | Escalation and learning live in separate contracts; `sizes.test.ts` enforces 24,576 bytes.                                                                                                                                                                                              | `sizes.test.ts`                                             |

## Edge cases covered by tests

`test/edgeCases.test.ts`: an event with no policies, all policies in one bucket (settled together
by evidence, or held together and settled by the default), a value of zero, values at and beyond
the top bucket, every oracle silent (the event is disputed with all collateral locked, then
resolved, and the silent members are penalised), every candidate's source already represented
(default without escalation), a rainfall event with only weather sources, and an LP withdrawing
during a held state.

## Known limitations

- The admin is a single key in the local setup. Use a multisig on any shared network.
- Oracle liveness is not guaranteed. If too few oracles reveal, the event ends in `DISPUTED` and
  waits for the admin; collateral stays locked meanwhile.
- `finalizeRound`, `applyDefault` and `resolveDispute` need more than 6,000,000 gas available
  because of the learning floor. Clients should use `estimateGas` with a margin.
- Timestamps decide the windows. A block producer can shift them by seconds, which is small next
  to the commit, reveal and challenge windows.
- Upstream sources are signed adapters. A source that signs a wrong value is detected only through
  disagreement with other sources and through learning; there is no proof of the data's origin
  beyond the source key.
- The baseline contracts in `contracts/baselines/` exist for the experiments only and are not
  hardened (no reentrancy guard; an unbounded settlement loop by design).

## Off-chain services

- The demo server listens on 127.0.0.1 only and refuses to run unless the chain id is 31337.
- Hardhat development keys are public and must never hold real funds. Source signer keys are
  generated locally into `services/.keys/` (gitignored).
- The keeper and oracle nodes are untrusted by the contracts. A faulty keeper can delay settlement
  but cannot change it.

## Static analysis (Slither)

Slither 0.11.6 over `contracts/` (mocks excluded), after the Milestone 9 fixes: 76 results, none
open. The fixed findings were the `resolveDispute` bond transfer (reentrancy with ETH, and the
gas-griefing case above), the event order in the baselines' `claim`, and a missing zero-address
check in `LearningModule.setEngine`.

| Detector (impact)                          | Count | Assessment                                                                                                                                                                     |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| arbitrary-send-eth (High)                  | 2     | By design: `Vault._send` pays the LP or the policy holder recorded on chain; `_payBond` sends a forfeited bond to the vault.                                                   |
| reentrancy-no-eth (Medium)                 | 7     | Calls go to the vault and policy book, which are trusted contracts set at deployment; every entry point is `nonReentrant`.                                                     |
| uninitialized-local (Medium)               | 25    | Counters and accumulators that rely on Solidity's zero default. Intentional.                                                                                                   |
| unused-return (Medium)                     | 8     | Tuple reads that skip fields the caller does not need. Intentional.                                                                                                            |
| incorrect-equality (Medium)                | 2     | `totalShares == 0` checks the first deposit. Intentional.                                                                                                                      |
| calls-loop (Low)                           | 11    | Calls to the registry and book inside loops bounded by 16 reports or 64 oracles.                                                                                               |
| timestamp (Low)                            | 10    | Windows and deadlines are time-based by specification.                                                                                                                         |
| reentrancy-benign (Low)                    | 2     | State written after calls to trusted contracts; no effect.                                                                                                                     |
| costly-loop, low-level-calls, other (Info) | 9     | The baselines' per-policy loop is what the experiments measure; low-level calls are ETH transfers with checked results; `_validate` is long because it checks every parameter. |

To reproduce (Python 3 and `pip install slither-analyzer`):

```bash
npx hardhat compile
slither . --hardhat-ignore-compile --filter-paths "node_modules|contracts/mocks"
```
