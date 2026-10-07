# Contracts

Solidity 0.8.24, OpenZeppelin 5.x. Values reported by sources are `uint256` in milli-units
(minutes x 1000 or millimetres x 1000). Ratios and weights use 1e18 fixed point (WAD).

## Overview

| Contract                | Role                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `Vault`                 | LP shares; free / locked / claimable accounting; pull payouts                             |
| `TIESRegistry`          | Versioned category parameters, sources, oracles, reputation, learned source dependence    |
| `PolicyBook`            | Events, quotes, policy binding with capacity checks, per-event collateral index, claims   |
| `SettlementEngine`      | Commit/reveal rounds, aggregation, running interval, range settlement, defaults, disputes |
| `SignedAdapterVerifier` | Derives a report's source id from the source adapter's signature                          |
| `EscalationPlanner`     | Read-only: decides whether another round is worthwhile and ranks oracles to recruit       |
| `LearningModule`        | Updates oracle reputation and learned source dependence once an event is final            |
| `ThresholdIndex` (lib)  | Fenwick tree over threshold buckets                                                       |
| `Aggregation` (lib)     | Weighted median, agreement weights, consensus, dispersion, effective sources, uncertainty |
| `TIESMath` (lib)        | WAD helpers, curve interpolation, attainable window                                       |

Roles: the deployer holds `DEFAULT_ADMIN_ROLE` everywhere. The engine holds `ENGINE_ROLE` on the
vault and the registry; the policy book holds `BOOK_ROLE` on the vault.

## Settlement flow

1. `PolicyBook.bind` locks the payout in the vault, forwards the premium to it and adds the payout
   to the event's Fenwick tree at the threshold bucket.
2. After the observation window anyone calls `SettlementEngine.openRound`. Committee members call
   `commit` then `reveal`. The reveal is checked against the commit and the verifier derives the
   source id from the source signature.
3. Anyone calls `finalizeRound` after the reveal deadline. The engine aggregates all revealed
   reports, derives the round interval, intersects it with the running interval `[L, U]`, and moves
   two cursors. Buckets with threshold <= L become claimable; buckets with threshold > U are
   unlocked. Both are single range queries on the Fenwick tree.
4. If collateral is still held, the engine either escalates or starts a pending default:
   - It escalates when rounds remain and either the round was insufficient or more than the trigger
     (`uMin`) is held. `EscalationPlanner` sizes the number of recruits from the margin to the
     most valuable held bucket, then ranks oracles on sources that are not yet represented by the
     gain in effective independent sources times their reputation. A new round opens with the
     selected oracles (`EscalationRequested`).
   - Otherwise (futile margin, no candidate, round limit, or little held) the event goes to
     `DEFAULT_PENDING`. After the challenge period `applyDefault` settles the rest at the last
     consensus value. A bonded `challenge` instead moves the event to `DISPUTED`, resolved by the
     admin with `resolveDispute`.
     When an event becomes `FINAL`, `LearningModule` updates reputation and source dependence.
5. `PolicyBook.claim(policyId)` pays a policy whose bucket is at or below the engine's pay cursor.

Cursors are clamped so a settled bucket never reverses and the pay and no-pay ranges never overlap.

## Parameters

Category parameters (spec defaults are in `packages/ties-math/src/defaults.ts`) are stored per
version. An event records the version that was current when it was created, so later edits never
change an existing event. Sources, oracles, reputation and dependence are live values.

`SignedAdapterVerifier.MAX_REPORT_AGE` (1 day) bounds how far before the observation end a report
timestamp may lie.

## Gas

Measured with `REPORT_GAS=true npx hardhat test` (optimizer on, 200 runs).

| Function                          | Gas (avg)                           |
| --------------------------------- | ----------------------------------- |
| `PolicyBook.bind`                 | 435,444 (340,869 - 571,942)         |
| `PolicyBook.claim`                | 59,842                              |
| `SettlementEngine.openRound`      | 397,578 (up to 8 committee members) |
| `SettlementEngine.commit`         | 57,468                              |
| `SettlementEngine.reveal`         | 147,704                             |
| `SettlementEngine.finalizeRound`  | 725,260 (246,527 - 1,171,771)       |
| `SettlementEngine.applyDefault`   | 583,145 (includes learning)         |
| `SettlementEngine.resolveDispute` | 874,808 (includes learning)         |
| `Vault.deposit` / `withdraw`      | 85,438 / 49,475                     |

`finalizeRound` is the widest range because it covers insufficient rounds (cheap), rounds that
escalate (planner call and committee storage) and rounds that finish the event (learning update).

### `finalizeRound` does not grow with the number of policies

Same reports, same interval, policies settled on both sides of the interval and some collateral
still held (test `settlement cost does not grow with the number of policies`):

| Policies on the event | `finalizeRound` gas |
| --------------------- | ------------------- |
| 10                    | 546,861             |
| 1,000                 | 546,861             |

The cost depends on the number of reports (at most 16) and sources, not on policies.

## Contract sizes (deployed bytecode)

| Contract                | Bytes  |
| ----------------------- | ------ |
| `SettlementEngine`      | 22,274 |
| `TIESRegistry`          | 14,300 |
| `PolicyBook`            | 12,257 |
| `LearningModule`        | 7,002  |
| `EscalationPlanner`     | 6,970  |
| `Vault`                 | 3,976  |
| `SignedAdapterVerifier` | 2,381  |

The limit is 24,576 bytes. `test/sizes.test.ts` enforces it. The engine has about 2.3 KB of
headroom, so escalation and learning live in separate contracts.

## Worked example (flight AI 101)

Four policies on the event (1 ETH at 60, 2 ETH at 120, 5 ETH at 125, 1 ETH at 130; 9 ETH locked).
Computed by the reference implementation and asserted by `test/escalation.test.ts`:

| Step             | Result                                                                |
| ---------------- | --------------------------------------------------------------------- |
| Round 1 reports  | 128 (S1), 131 and 130 (S2, two keys)                                  |
| Round 1 evidence | V = 129.67 min, sigma = 2.61, N_eff = 1.55 (< 1.8): insufficient      |
| Escalation       | held 9 ETH > 2 ETH trigger: recruit 2 oracles on S4 and S5            |
| Round 2 reports  | 133 (S4), 132 (S5)                                                    |
| Round 2 evidence | V = 130.81 min, N_eff = 2.35, interval [124.01, 137.62]               |
| Settlement       | pay cursor 124: the 60 and 120 policies pay (3 ETH); 6 ETH stays held |
| Next             | no unrepresented source left: `DEFAULT_PENDING`                       |

Under the rule "a policy pays if its threshold is at or below L", the 125 policy is held only
because L (124.01) is below 125.

## Learning update

After an event is final at value V*, each reporting oracle's category reputation becomes
`alpha <- gamma*alpha + (1 - flip)*[err <= eps]` and `beta <- gamma*beta + flip + [err > eps]`, where
`flip` is the share of the event's collateral whose pay decision would differ if judged at the
oracle's value instead of V*. Committee members that never revealed get `beta <- gamma*beta + 1`.
For each pair of sources present, dependence moves toward 1 when both sources' mean errors exceed
the tolerance with the same sign, and decays toward the prior otherwise.

## Events

`CategoryUpdated`, `SourceRegistered`, `SourceUpdated`, `ToolHashUpdated`, `OracleRegistered`,
`OracleUpdated`, `ReputationUpdated`, `DependenceUpdated`, `EventCreated`, `PolicyBound`, `Claimed`,
`EngineSet`, `Deposit`, `Withdraw`, `RoundOpened`, `ReportCommitted`, `ReportRevealed`,
`RoundFinalized`, `EventStatusChanged`, `EventDefaultPending`, `EventChallenged`, `EventDisputed`,
`EscalationRequested`, `DefaultApplied`, `DisputeResolved`, `EventFinalized`.

`RoundFinalized(eventId, round, status, V, sigma, nEff, L, U, payCursor, noPayCursor, newPay,
newNoPay, held)`: `status` is 0 insufficient, 1 valid, 2 disputed. Before the first valid interval
`L` is 0 and `U` is `type(uint256).max`. Cursors are -1 and `bucketCount` when nothing is settled.
