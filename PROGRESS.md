# Progress

## Milestones

- [x] M0 Repo bootstrap and hygiene (`m0-bootstrap`)
- [ ] M1 Core contracts: index, vault, registry, policy book (`m1-core-contracts`)
- [ ] M2 Evidence, settlement, disputes (`m2-settlement`)
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
