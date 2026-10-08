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
   - After an insufficient round the engine always tries to recruit for sufficiency; the
     futility rule only ends escalation after a sufficient round.
   - If no round ever produced a valid interval, the event goes to `DISPUTED`
     (`INSUFFICIENT_EVIDENCE`) for the admin: collateral never moves on evidence from fewer than
     N_min independent sources.
   - Otherwise (futile margin, no candidate, no report capacity, round limit, or little held) the
     event goes to `DEFAULT_PENDING`. After the challenge period `applyDefault` settles the rest at the last
     consensus value clamped into [L, U]. A bonded `challenge` instead moves the event to `DISPUTED`, resolved by the
     admin with `resolveDispute`.
     When an event becomes `FINAL`, `LearningModule` updates reputation and source dependence.
     The update runs in try/catch (`LearningSkipped` on failure) and needs `LEARNING_GAS_FLOOR`
     (6,000,000) gas left, so callers should use `estimateGas`.
5. `PolicyBook.claim(policyId)` pays a policy whose bucket is at or below the engine's pay cursor.

Cursors are clamped so a settled bucket never reverses and the pay and no-pay ranges never overlap.

## Parameters

Category parameters (spec defaults are in `packages/ties-math/src/defaults.ts`) are stored per
version. An event records the version that was current when it was created, so later edits never
change an existing event. Sources, oracles, reputation and dependence are live values.

`SignedAdapterVerifier.MAX_REPORT_AGE` (1 day) bounds how far before the observation end a report
timestamp may lie.

## Gas

Snapshot from `REPORT_GAS=true npx hardhat test` (optimizer on, 200 runs, 151 tests). Values are
min / max / average over every call the tests make, so they mix small and large cases. The engine
rows come from the test harness, which is the production engine plus two test-only helpers.

| Function                          | Min     | Max       | Average |
| --------------------------------- | ------- | --------- | ------- |
| `PolicyBook.bind`                 | 340,891 | 596,167   | 446,874 |
| `PolicyBook.claim`                | 59,160  | 63,960    | 61,401  |
| `SettlementEngine.openRound`      | 283,149 | 477,213   | 399,223 |
| `SettlementEngine.commit`         | 53,848  | 73,756    | 56,985  |
| `SettlementEngine.reveal`         | 123,296 | 164,839   | 149,628 |
| `SettlementEngine.finalizeRound`  | 174,568 | 1,174,051 | 721,827 |
| `SettlementEngine.challenge`      | -       | -         | 80,829  |
| `SettlementEngine.applyDefault`   | 468,632 | 1,138,436 | 760,854 |
| `SettlementEngine.resolveDispute` | 470,932 | 1,164,423 | 780,939 |
| `Vault.deposit`                   | 55,743  | 92,211    | 87,978  |
| `Vault.withdraw`                  | 44,699  | 49,487    | 48,284  |

`finalizeRound` has the widest range because it covers insufficient rounds (cheap), rounds that
escalate (planner call and committee storage) and rounds that finish the event (learning update).
`applyDefault` and `resolveDispute` include the learning update. Because of `LEARNING_GAS_FLOOR`
(6,000,000), callers of `finalizeRound`, `applyDefault` and `resolveDispute` should send
`estimateGas` plus a margin rather than a fixed limit.

Binding is the expensive user step. Measured on one event (deployment defaults):

| Bind                                     | Gas     |
| ---------------------------------------- | ------- |
| First policy on the event                | 523,987 |
| Another policy in an already used bucket | 352,987 |
| First policy in a new bucket             | 453,184 |

About 105,000 of every bind is reading the event's full parameter version from the registry
(including the curve and z arrays). The rest is writing the Fenwick tree (most expensive when its
nodes are still empty), the capacity range query, the policy record and the vault calls. Caching
the few parameters `bind` needs in the policy book when the event is created would save most of
the parameter read; it is not done, because a TIES bind would still cost several times a baseline
bind, which stores only the policy. The experiments compare both in
[EXPERIMENTS.md](EXPERIMENTS.md).

### `finalizeRound` does not grow with the number of policies

Same reports, same interval, policies settled on both sides of the interval and some collateral
still held (test `settlement cost does not grow with the number of policies`):

| Policies on the event | `finalizeRound` gas |
| --------------------- | ------------------- |
| 10                    | 530,466             |
| 1,000                 | 530,466             |

The cost depends on the number of reports (at most 16) and sources, not on policies.

## Contract sizes (deployed bytecode)

| Contract                | Bytes  |
| ----------------------- | ------ |
| `SettlementEngine`      | 23,918 |
| `TIESRegistry`          | 14,463 |
| `PolicyBook`            | 12,257 |
| `LearningModule`        | 7,002  |
| `EscalationPlanner`     | 6,937  |
| `Vault`                 | 3,976  |
| `SignedAdapterVerifier` | 2,381  |

The limit is 24,576 bytes. `test/sizes.test.ts` enforces it. The engine has about 0.6 KB of
headroom, so escalation and learning live in separate contracts.

## API

Only the functions a client or operator calls are listed. Every function has NatSpec in the source.

### `Vault`

| Function                                                                            | Who           |
| ----------------------------------------------------------------------------------- | ------------- |
| `deposit() payable returns (shares)`                                                | anyone        |
| `withdraw(assets) returns (shares)`, at most `maxWithdraw(account)`                 | LP            |
| `totalAssets()`, `freeLiquidity()`, `locked()`, `claimable()`, `convertToAssets(s)` | view          |
| `sharesOf(account)`, `totalShares()`, `maxWithdraw(account)`                        | view          |
| `lock(amount)` / `payClaim(to, amount)`                                             | `BOOK_ROLE`   |
| `unlock(amount)` / `moveLockedToClaimable(amount)`                                  | `ENGINE_ROLE` |

### `TIESRegistry`

| Function                                                                                       | Who           |
| ---------------------------------------------------------------------------------------------- | ------------- |
| `setCategory(category, params) returns (version)`                                              | admin         |
| `registerSource(signer, category, name, toolHashes)`, `setSourceActive`, `setToolHash`         | admin         |
| `registerOracle(oracle, category, sourceId, primary)`, `updateOracle(...)`                     | admin         |
| `getParams(category, version)`, `latestVersion`, `versionCount`                                | view          |
| `getSource`, `sourceIdOfSigner`, `toolHashAllowed`, `activeSourceCount`                        | view          |
| `getOracle`, `isOracle`, `oracleCount`, `oracleAt`, `activePrimaryOracles`, `activeOracleInfo` | view          |
| `reputation`, `reputationWeight`, `dependence`, `dependenceVector`, `dependenceMatrix`         | view          |
| `setReputation`, `setDependence`                                                               | `ENGINE_ROLE` |

### `PolicyBook`

| Function                                                                               | Who    |
| -------------------------------------------------------------------------------------- | ------ |
| `createEvent(category, label, observationKey, cutoff, observationEnd)`                 | admin  |
| `setEngine(engine)`                                                                    | admin  |
| `quote(eventId, bucket, payout)`                                                       | view   |
| `bind(eventId, bucket, payout) payable returns (policyId)`; excess premium is refunded | anyone |
| `claim(policyId)`; pays the holder once the bucket is at or below the pay cursor       | anyone |
| `eventData`, `eventMeta`, `eventLocked`, `getPolicy`, `policiesOf`                     | view   |
| `rangeCollateral(eventId, from, to)`, `bucketsInRange(eventId, from, to)` (max 1,024)  | view   |
| `windowOf(eventId)`, `capacityLeftNear(eventId, bucket)`, `nearestAvailableBucket`     | view   |

### `SettlementEngine`

| Function                                                                                                           | Who              |
| ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `openRound(eventId)` after the observation end                                                                     | anyone (keeper)  |
| `commit(eventId, round, commitHash)`                                                                               | committee member |
| `reveal(eventId, round, value, ts, toolHash, argsHash, responseHash, sourceSig, salt)`                             | committee member |
| `finalizeRound(eventId)` after the reveal deadline                                                                 | anyone (keeper)  |
| `challenge(eventId) payable` with exactly `CHALLENGE_BOND` (0.05 ETH) while `DEFAULT_PENDING`                      | anyone           |
| `applyDefault(eventId)` after the challenge deadline                                                               | anyone (keeper)  |
| `resolveDispute(eventId, finalValue)`                                                                              | admin            |
| `withdrawBond()`; a returned bond that could not be pushed to the challenger                                       | challenger       |
| `eventState`, `payCursor`, `noPayCursor`, `held`, `reportCount`, `reportAt`, `committeeOf`, `commitOf`, `bondOwed` | view             |

`commitHash = keccak256(abi.encode(value, ts, toolHash, argsHash, responseHash, sourceSig, salt,
oracle))`. The source signs `keccak256(abi.encode(chainId, engine, eventId, value, ts, toolHash,
argsHash, responseHash))` as an EIP-191 personal message.

A returned bond is sent with a 50,000 gas cap (`BOND_REFUND_GAS`). If the challenger cannot accept
it, it is recorded in `bondOwed` (`BondOwed` event) and the challenger calls `withdrawBond`. This
keeps a challenger contract from blocking the resolution. A forfeited bond goes to the vault.

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
`EscalationRequested`, `DefaultApplied`, `DisputeResolved`, `EventFinalized`, `LearningSkipped`,
`BondOwed`.

`RoundFinalized(eventId, round, status, V, sigma, nEff, L, U, payCursor, noPayCursor, newPay,
newNoPay, held)`: `status` is 0 insufficient, 1 valid, 2 disputed. Before the first valid interval
`L` is 0 and `U` is `type(uint256).max`. Cursors are -1 and `bucketCount` when nothing is settled.
