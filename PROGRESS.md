# Progress

## Milestones

- [x] M0 Repo bootstrap and hygiene (`m0-bootstrap`)
- [x] M1 Core contracts: index, vault, registry, policy book (`m1-core-contracts`)
- [x] M2 Evidence, settlement, disputes (`m2-settlement`)
- [x] M3 Escalation, recruitment, learning (`m3-escalation-learning`)
- [x] M4 Off-chain services and one-command local stack (`m4-services`)
- [x] M5 Frontend foundation and design system (`m5-frontend-foundation`)
- [x] M6 Core user screens (`m6-core-screens`)
- [ ] M7 Remaining role screens (`m7-role-screens`)
- [ ] M8 Baselines, experiments, demo lab, presenter panel (`m8-demo-experiments`)
- [ ] M9 Hardening, polish, documentation (`m9-hardening`)
- [ ] M10 Sepolia deployment (gated) (`m10-sepolia`)

## Notes

### M0

Built: npm workspaces (root, `packages/*`, `services/*`, `frontend`), Hardhat 2.22.17 with the
toolbox plugin set pinned to versions that support it, OpenZeppelin 5.x, TypeScript, ESLint, Prettier,
solhint, Vite React TS skeleton, CI workflow, README and RUNNING docs.

Run: `npm install`, `npm run lint`, `npx hardhat compile`, `npm -w frontend run build`.

Known issues:

- `npm audit` reports vulnerabilities, all in Hardhat's dev tooling chain; none ship to users.
- Hardhat plugins are pinned exactly (newer plugin releases require Hardhat 2.24+).
- solhint is skipped by `scripts/lint-sol.mjs` until contracts exist (M1).

### M1

Built:

- `ThresholdIndex` (Fenwick tree with signed, clamped range queries) and `TIESMath` (WAD helpers,
  piecewise-linear interpolation, attainable window).
- `Vault` (shares with dead-share inflation guard, free/locked/claimable accounting, pull payouts).
- `TIESRegistry` (versioned category parameters, sources with tool-hash allowlist, oracles,
  reputation, learned dependence).
- `PolicyBook` (events, quote, bind with the three capacity checks, O(1) claim wired to the engine
  through `ISettlementEngine.payCursor`, read-only views for the UI).
- `packages/ties-math`: BigInt Fenwick tree, pricing, window and the spec 3.2 defaults.

Decisions recorded (all from `OPEN_QUESTIONS.md`): parameters are snapshotted per event by storing a
version index (B6); 1-unit buckets (B1); read-only UI views added to the policy book (B11).

Notes:

- `PolicyBook.getEvent` is exposed as `eventData` because `getEvent` collides with a built-in ethers
  `Contract` method.
- The vault-liquidity check (spec 3.3 check 3) can never fail first while eta <= 1, because the
  per-event share check is stricter; it is kept as specified.
- `maxAge` (report timestamp window, spec 3.4) has no default in the spec. It is needed in M2.

Run: `npm test`, `npx hardhat coverage`.

Tests: 60 contract tests + 6 ties-math tests. Function coverage 100% (statements 99.5%).
Contract sizes: PolicyBook 12.1 KB, TIESRegistry 12.1 KB, Vault 4.0 KB (limit 24.6 KB).

### M2

Built:

- `SignedAdapterVerifier` (EIP-191 recovery, source lookup by signer, category, active flag, tool
  hash allowlist, timestamp window) behind `IOriginVerifier`.
- `Aggregation` library and its `ties-math` mirror (weighted median, agreement weights, consensus,
  dispersion, N_eff, sigma).
- `SettlementEngine`: open / commit / reveal / finalize, running intersection, range settlement,
  `DEFAULT_PENDING`, `challenge`, `applyDefault`, `resolveDispute`, status events.
- `ties-math`: aggregation, round interval, cursor and range-settlement reference, brute force.
- Test-only mocks: aggregation harness, engine harness (opens a further round), bind batcher.

Tests: 101 passing, 1 pending (the size check skips itself under coverage). Function coverage 100%
on all contracts. Properties P1, P2, P3, P4, P5, P6 are covered (see `test/engine.test.ts`,
`test/vault.test.ts`, `test/verifier.test.ts`). P4: 523,864 gas at 10 policies, 524,277 at 1,000.

Decisions and notes:

- `maxAge` has no value in the spec; a 1-day constant is used (question D1).
- Cursors are clamped so default and dispute resolution can never reverse or double-settle a
  bucket (D3).
- Escalation is a stub that goes straight to `DEFAULT_PENDING`; M3 completes it.
- The engine is 18.0 KB. Escalation and learning will be added in M3 and may need an external
  library to stay under 24.6 KB.
- Open item for the M3 review: a default after rounds that never reached N_min settles at the
  last consensus (D2).

### M3

Built:

- `EscalationPlanner` (read-only): recruit count from the margin to the most valuable held bucket,
  futility rule, candidates on unrepresented sources ranked by N_eff gain times reputation, ties
  broken by `keccak256(prevrandao, eventId, oracle)`.
- `LearningModule`: reputation and source-dependence update when an event becomes final, plus the
  penalty for committee members that never revealed.
- Engine: escalation (`EscalationRequested`, next round opens with the selected committee),
  learning on `FINAL` (also after a default or a resolved dispute).
- Registry views for the planner: `activeOracleInfo`, `dependenceVector`, `dependenceMatrix`.
- `ties-math`: `planEscalation`, `updateReputation`, `silentPenalty`, `flipShare`,
  `updateDependence`, and per-report weights in the aggregation result.

Tests: 119 passing, 1 pending. Function coverage 100%, line coverage 99.4%. Scripted worked
example, duplicate-source escalation, futility, no candidates, compromised source, dependence
learning, silent penalty, randomised checks (k never above k_round, rounds never above K_max,
recruits never on a represented source). `finalizeRound` gas is identical at 10 and 1,000
policies (546,861).

Interpretation calls to review (see `.claude/OPEN_QUESTIONS.md`, D2 and D4-D6):

- D2: a default after rounds that never reached N_min settles at the last consensus.
- D4: for held ranges wider than 64 buckets the planner scans the 64 buckets around the
  consensus for the most valuable one (a literal "bucket nearest V" would make almost every
  escalation futile and contradicts the worked example).
- D5: `k` is raised to 1 when the formula gives 0.
- D6: silent committee members lose only beta, once per event.

The engine is 22.3 KB (limit 24.6 KB). Planner and learning are separate contracts.

### M3 review (checkpoint)

Reviewed the contracts against the spec and the settlement properties. The mechanism is intact.
Changes made in the review:

- An event whose rounds never reach N_min is disputed for the admin instead of defaulting, so no
  collateral ever moves on evidence from fewer than N_min independent sources (P1 on every path).
- After an insufficient round the engine always recruits for sufficiency; futility applies only to
  sufficient rounds.
- A scan window without collateral imposes no margin.
- The default value is the last consensus clamped into [L, U].
- The learning update can no longer block settlement (try/catch with a gas floor; `rho0 = 0` is
  rejected).
- Escalation respects the remaining report capacity; oracles on deactivated sources are not
  recruited.

New tests: `test/safety.test.ts` (11). Totals: 131 contract tests + 6 ties-math tests, function
coverage 100%, line coverage 99.4%. Engine size 22.8 KB.

Note for M4 keeper: `finalizeRound`, `applyDefault` and `resolveDispute` need at least
`LEARNING_GAS_FLOOR` (6M) gas left when the event becomes final; use `estimateGas`.

### M4

Built:

- `services/shared`: topology (sources, ports, accounts), key handling, deployment watcher, ABI
  loading, report signing and hashing, error decoding, HTTP helpers.
- `services/sources`: nine signed source servers (ports 7101-7109). Each has an MCP endpoint
  (`/mcp`, Streamable HTTP, tools `get_flight_delay` and `get_rainfall_24h`), `/control`,
  `/truth` and `/health`. S7 calls the real Open-Meteo archive (forecast fallback).
- `services/oracle-node`: ten nodes on keys #10-#17 (MCP client, commit, reveal; modes honest,
  tamper, silent, late), `GET /status`, `POST /nodes/:id/mode|start|stop`.
- `services/keeper`: opens rounds, finalizes rounds (gas from `estimateGas`, which covers the 6M
  learning floor), applies defaults.
- `services/demo-server`: presenter REST and SSE API, scenario runner, transaction watcher.
- `scripts/deploy.ts`, `seed.ts`, `export-abi.ts`, `demo-cli.ts`; `npm run dev:stack`.
- `experiments/scenarios.ts`: twelve declarative scenarios shared with the demo server.
- `test/services.test.ts`: starts the services against a separate Hardhat node and runs
  `honest`, `compromised-feed` and `forged-report`.

Run: `npm run dev:stack`, then `npm run demo:cli -- --scenario compromised-feed`.

Tests: 135 contract and integration tests, 6 ties-math tests. All twelve scenarios were also run
by hand against the live stack.

Observed results (local chain, deterministic noise):

- `compromised-feed`: round 1 INSUFFICIENT (N_eff 1.00, nothing moved), three rounds, final value
  128.1 against a truth of 130, no wrong settlement.
- `two-keys-one-feed`: round 1 INSUFFICIENT (N_eff 1.61), round 2 VALID after recruiting an
  unrepresented source.
- `forged-report`: the tampered reveal reverts with `UnknownSigner`; the event settles from the
  others.
- `borderline`: escalation judged futile, settled by default, two policies one minute from the
  truth settled the wrong way. This is the honest limit of the interval, not a bug.
- `real-weather`: Open-Meteo reported 38.5 mm for Chennai on 2025-10-22; settled in round 1.

Decisions and deviations (planning notes D10 to D12):

- A third rainfall source (S9) was added. With the default prior rho0 = 0.2, two distinct sources
  give N_eff = 1.67, below N_min = 1.8, so a rainfall event with only S7 and S8 could never settle
  without the admin.
- `inconsistent-rounds` does not end in DISPUTED. The agreement kernel and the 4s outlier cut
  discount late reports that disagree with round 1, and the dispersion term widens the new
  interval, so the intervals keep overlapping and the running intersection holds. A disputed path
  is shown by the extra `challenged-default` scenario.
- Keys #10 and #11 serve two categories (flight and rain), because the spec has eight keys for
  nine sources.
- `SerialWallet` replaces the ethers `NonceManager`: a failed send (a reveal that reverts) made
  the manager drift and later transactions failed.

Known issues:

- The seeded demo events stay open and are worked on by the keeper and nodes as scenarios advance
  time; their windows can be skipped. Harmless on a demo chain.

### M5

Built:

- Design tokens and component CSS imported; every design component rebuilt as a typed React
  component in `frontend/src/components` (controls, status chips, panels, tables, transaction
  flow, tray and toast, shell and header, threshold slider, interval chart, round timeline,
  source list, N_eff gauge, money split, escalation panel, event card and log row).
- `/__components` gallery route (development builds only) for comparing with the previews.
- Hooks: `useWallet`, `useNetwork`, `useContracts`, `useTx` (six-state machine, global tray,
  toasts, decoded events and reverts), `useContractEvents` (one block-driven log fetch),
  `useEventState`, `useVault`, `useRoles`.
- Libraries: network config (31337 and 11155111, add and switch chain), ABI and deployment loader,
  custom-error decoder with plain-language messages, formatting helpers.
- App shell with role-filtered nav, live block indicator, network chip, pending-tx tray,
  light/dark toggle, wrong-network and not-deployed banners; routes for every screen are
  placeholders until M6 and M7.
- `docs/DESIGN_MAPPING.md`.

Tests: 6 frontend unit tests (formatting, settlement rule per bar, error decoding).

Known issues:

- Not yet checked against MetaMask in a real browser session, and the screens are placeholders.
- The in-browser check so far is the gallery rendering in dark mode without console errors.

### M6

Built (all four screens read live contract data; no demo values):

- Events marketplace: category, status and search filters kept in the URL, loading, empty and
  error states, cards with real capacity and cover bound, links to buy and to the explorer.
- Settlement explorer: threshold chart coloured from the engine's settlement cursors, round
  timeline from `RoundFinalized` (round interval = V ± z·sigma) with the running intersection,
  sources grouped by origin with per-report weights recomputed off-chain with `ties-math` (shown
  only when they reproduce the on-chain V and N_eff), N_eff gauge, money split, escalation panel
  with countdowns and commit count, live ticker, and the insufficient, disputed and settled
  states. Actions: open round, settle now (`finalizeRound` with a gas limit from `estimateGas`,
  which covers the learning gas floor), apply default, challenge.
- Buy cover: threshold slider with the bound-cover histogram and capacity window, capacity meter,
  debounced quote with a premium split rebuilt from the event's parameters (total is always the
  contract quote), checks before signing (cutoff, capacity window, per-event share of the vault),
  gas estimate, six-state transaction flow with decoded reverts.
- My policies: tiles, per-policy status, inline threshold vs interval bar, claim and claim all.

Checked in the browser against a live stack (Hardhat accounts standing in for MetaMask): bought
cover on a seeded event, saw a decoded `EventShareExceeded` revert before the pre-check existed,
advanced time, let the keeper and oracle nodes settle three events, watched the explorer update
(interval, weights, money split, default pending), applied the default and claimed two policies;
balance rose by 2 ETH. Real MetaMask has not been used.

Known issues:

- The block-based countdowns follow the chain's latest block time, which does not move on an idle
  local chain until the presenter advances time.
- Light theme not compared screen by screen yet (dark checked); polish is planned for M9.
