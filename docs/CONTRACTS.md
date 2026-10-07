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
4. If collateral is still held, the event goes to `DEFAULT_PENDING` (escalation is added in a later
   milestone). After the challenge period `applyDefault` settles the rest at the last consensus
   value. A bonded `challenge` instead moves the event to `DISPUTED`, resolved by the admin with
   `resolveDispute`.
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

| Function                          | Gas (avg)                    |
| --------------------------------- | ---------------------------- |
| `PolicyBook.bind`                 | 435,444 (340,869 - 571,942)  |
| `PolicyBook.claim`                | 59,842                       |
| `SettlementEngine.openRound`      | 455,014 (8-oracle committee) |
| `SettlementEngine.commit`         | 57,947                       |
| `SettlementEngine.reveal`         | 146,982                      |
| `SettlementEngine.applyDefault`   | 245,258                      |
| `SettlementEngine.resolveDispute` | 252,052                      |
| `Vault.deposit` / `withdraw`      | 85,438 / 49,475              |

### `finalizeRound` does not grow with the number of policies

Same reports, same interval, policies settled on both sides of the interval (test
`settlement cost does not grow with the number of policies`):

| Policies on the event | `finalizeRound` gas |
| --------------------- | ------------------- |
| 10                    | 523,864             |
| 1,000                 | 524,277             |

The difference is 413 gas (0.08%). The cost depends on the number of reports (at most 16), not on
policies.

## Contract sizes (deployed bytecode)

| Contract                | Bytes  |
| ----------------------- | ------ |
| `SettlementEngine`      | 18,031 |
| `PolicyBook`            | 12,257 |
| `TIESRegistry`          | 12,115 |
| `Vault`                 | 3,976  |
| `SignedAdapterVerifier` | 2,381  |

The limit is 24,576 bytes. `test/sizes.test.ts` enforces it.

## Events

`CategoryUpdated`, `SourceRegistered`, `SourceUpdated`, `ToolHashUpdated`, `OracleRegistered`,
`OracleUpdated`, `ReputationUpdated`, `DependenceUpdated`, `EventCreated`, `PolicyBound`, `Claimed`,
`EngineSet`, `Deposit`, `Withdraw`, `RoundOpened`, `ReportCommitted`, `ReportRevealed`,
`RoundFinalized`, `EventStatusChanged`, `EventDefaultPending`, `EventChallenged`, `EventDisputed`,
`DefaultApplied`, `DisputeResolved`, `EventFinalized`.

`RoundFinalized(eventId, round, status, V, sigma, nEff, L, U, payCursor, noPayCursor, newPay,
newNoPay, held)`: `status` is 0 insufficient, 1 valid, 2 disputed. Before the first valid interval
`L` is 0 and `U` is `type(uint256).max`. Cursors are -1 and `bucketCount` when nothing is settled.
