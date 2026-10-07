# Design to contracts mapping

The design notes use placeholder contract names. This table maps each one to the real contracts
and functions. Rows marked **ask** are things the design shows that the contracts do not have.

## Contracts

| Design name    | Real contract(s)                                                | Notes                                                                |
| -------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| EventBook      | `PolicyBook` (events) + `SettlementEngine` (rounds, settlement) | Split in two: event data and bucket totals vs. evidence and cursors. |
| ThresholdIndex | `PolicyBook` (Fenwick tree per event)                           | Not a separate contract; read through `PolicyBook` views.            |
| PolicyManager  | `PolicyBook`                                                    | `quote`, `bind`, `claim`, `policiesOf`, `getPolicy`.                 |
| Vault          | `Vault`                                                         | Same role.                                                           |
| ReportHub      | `SettlementEngine`                                              | `commit`, `reveal`.                                                  |
| OracleRegistry | `TIESRegistry`                                                  | Admin-registered oracles, no bonds (decision B3).                    |
| SourceRegistry | `TIESRegistry`                                                  | Sources, signer, tool-hash allowlist.                                |
| ParamStore     | `TIESRegistry`                                                  | Versioned category parameters; events snapshot a version (B6).       |
| DisputeDesk    | `SettlementEngine`                                              | `challenge`, `applyDefault`, `resolveDispute`.                       |
| Baselines      | `contracts/baselines/*` (Milestone 8)                           | Lab only.                                                            |

## Reads

| Design call                                              | Real call                                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `events(id)`, `status(id)`                               | `PolicyBook.eventData(id)`, `SettlementEngine.eventState(id).status`                                                        |
| `interval(id)` {L, U, V, nEff, round}                    | `eventState(id)`: `lowerBound`, `upperBound`, `vLast`, `nEffLast`, `round`                                                  |
| `rounds(id, i)`                                          | `RoundFinalized` events                                                                                                     |
| `settledPay/settledNoPay/held(id)`                       | `eventState(id).settledPay/settledNoPay`, `SettlementEngine.held(id)`                                                       |
| `sourceWeight(id, originId)`                             | Not on chain per source. Per-report weights are recomputed in the UI with `ties-math` from `ReportRevealed` and reputation. |
| `bucketsInRange(id, from, to)`                           | `PolicyBook.bucketsInRange`                                                                                                 |
| `capacityLeft(id)`, `capacityLeftNear`                   | `PolicyBook.capacityLeftNear(id, bucket)`; totals from `eventLocked`                                                        |
| `totalBound(id)`                                         | `PolicyBook.eventLocked(id)`                                                                                                |
| `quote(id, threshold, payout)`                           | `PolicyBook.quote(id, bucket, payout)` returns one number (premium incl. escalation fee)                                    |
| `policiesOf(account)`, `policy(pid)`                     | `PolicyBook.policiesOf`, `getPolicy`                                                                                        |
| `totalAssets/freeAssets/lockedCollateral/claimableTotal` | `Vault.totalAssets/freeLiquidity/locked/claimable`                                                                          |
| `sharesOf`, `maxWithdraw`                                | `Vault.sharesOf`, `Vault.maxWithdraw`                                                                                       |
| `lockedByEvent(id)`                                      | `PolicyBook.eventLocked(id)`                                                                                                |
| `commits(id, round, oracle)`                             | `SettlementEngine.commitOf`                                                                                                 |
| `isOracle(a)`, `nodes(a)`, `reputation`                  | `TIESRegistry.isOracle`, `getOracle(a, category)`, `reputation(a, category)`                                                |
| `sources(originId)`, `allowedSchemas`                    | `TIESRegistry.getSource(id)`, `toolHashAllowed(id, hash)`                                                                   |
| `params(category)`                                       | `TIESRegistry.getParams(category, version)`, `latestVersion`                                                                |
| `disputes(id)`                                           | `eventState(id)`: `status == DISPUTED`, `disputeReason`, `challenger`, `bond`                                               |
| Owner check                                              | `TIESRegistry.hasRole(DEFAULT_ADMIN_ROLE, account)`                                                                         |

## Writes

| Design call                | Real call                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `settle(id)`               | `SettlementEngine.finalizeRound(id)` (anyone; also `openRound`, `applyDefault`)                        |
| `createEvent(...)`         | `PolicyBook.createEvent(category, label, observationKey, cutoff, observationEnd)` (admin)              |
| `buyCover(...)`            | `PolicyBook.bind(id, bucket, payout)` payable                                                          |
| `claim(pid)`               | `PolicyBook.claim(pid)`                                                                                |
| `deposit()`, `withdraw(a)` | `Vault.deposit()` payable, `Vault.withdraw(assets)`                                                    |
| `commit`, `reveal`         | `commit(id, round, hash)`, `reveal(id, round, value, ts, toolHash, argsHash, responseHash, sig, salt)` |
| `challenge(...)`           | `SettlementEngine.challenge(id)` payable, fixed 0.05 ETH bond                                          |
| `resolve(...)`, `default`  | `resolveDispute(id, finalValue)` (admin), `applyDefault(id)`                                           |
| `setParams(category, p)`   | `TIESRegistry.setCategory(category, params)` (new version)                                             |
| `approve/revoke` source    | `registerSource`, `setSourceActive`, `setToolHash`                                                     |
| oracle `allow/disallow`    | `registerOracle`, `updateOracle(..., primary, active)`                                                 |

## Events

| Design event                                               | Real event                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `EventCreated(... descriptorHash, windowStart, windowEnd)` | `EventCreated(eventId, category, label, cutoff, observationEnd)` (C3)                                          |
| `PolicyBound`                                              | `PolicyBound(policyId, eventId, holder, bucket, payout, premium)`                                              |
| `CollateralLocked/Released`                                | Not emitted (B8). Derived from `PolicyBound`, `RoundFinalized.newPay/newNoPay`.                                |
| `ReportCommitted`                                          | `ReportCommitted(eventId, round, oracle)`                                                                      |
| `ReportSubmitted`                                          | `ReportRevealed(eventId, round, oracle, sourceId, value)`                                                      |
| `RoundSettled`                                             | `RoundFinalized(eventId, round, status, V, sigma, nEff, L, U, payCursor, noPayCursor, newPay, newNoPay, held)` |
| `EscalationRequested`                                      | `EscalationRequested(eventId, nextRound, k, selected, held)`; deadlines from `RoundOpened`                     |
| `ReportRequested` (inbox)                                  | Not emitted (C2). Inbox uses `RoundOpened(committee)`.                                                         |
| `Disputed`                                                 | `EventDisputed(eventId, reason)`, `EventChallenged`                                                            |
| `Claimed`                                                  | `Claimed(policyId, holder, amount)`                                                                            |
| `Deposit/Withdraw`                                         | `Deposit(lp, assets, shares)`, `Withdraw(lp, assets, shares)`                                                  |
| `ParamsUpdated`                                            | `CategoryUpdated`                                                                                              |
| `ReputationUpdated`                                        | `ReputationUpdated(oracle, category, alpha, beta)`                                                             |

## Where the design differs from the contracts (decisions already made)

B1 to B11 and C1 to C3 settle the earlier conflicts (1-unit buckets, spec settlement rule, no
bonds, admin dispute resolution, fixed challenge bond, parameter snapshots, timestamp deadlines,
account roles). The build follows them.

## Decisions on the remaining items

1. **Quote breakdown.** The UI rebuilds pure risk (`payout × q(θ)`), margin and escalation fee
   from the event's parameter version, with the same rounding as the contract. The total shown is
   always the on-chain `quote` value (that is what `bind` charges); the split is labelled
   "computed from category parameters". If the rebuilt parts ever disagree with `quote` by more
   than 1 wei, the UI shows only the total.
2. **Per-source weight.** The UI recomputes per-report weights with `packages/ties-math`
   (`aggregate`, the same integer maths the contract uses) from `ReportRevealed` values and
   each oracle's reputation. It checks its V and N_eff against the latest `RoundFinalized`;
   when they match the weights are shown and labelled "computed off-chain", otherwise the weight
   column is hidden.
3. **Verified-origin badge.** Every report accepted on chain shows "Verified origin · Signed MCP"
   (the only verifier deployed). zkTLS and enclave are not shown anywhere in the UI.
4. **Rain sources and disputes.** D10 (three rain sources, S7 to S9) and D11 (the
   `inconsistent-rounds` scenario shows the intersection holding) are accepted. The disputes
   queue handles all three reasons the contract can emit: `INCONSISTENT_EVIDENCE` (empty
   intersection, still enforced by the contract and covered by the contract tests),
   `CHALLENGED` and `INSUFFICIENT_EVIDENCE`.
5. **Presenter-only data.** Block "≈ minutes" hints on localhost are shown only when blocks are
   being produced (an idle local chain has no blocks).
