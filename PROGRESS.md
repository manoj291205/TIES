# Progress

## Milestones

- [x] M0 Repo bootstrap and hygiene (`m0-bootstrap`)
- [x] M1 Core contracts: index, vault, registry, policy book (`m1-core-contracts`)
- [x] M2 Evidence, settlement, disputes (`m2-settlement`)
- [ ] M3 Escalation, recruitment, learning (`m3-escalation-learning`)
- [ ] M4 Off-chain services and one-command local stack (`m4-services`)
- [ ] M5 Frontend foundation and design system (`m5-frontend-foundation`)
- [ ] M6 Core user screens (`m6-core-screens`)
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
