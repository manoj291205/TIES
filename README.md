# TIES

Threshold-indexed parametric insurance for flight delays and rainfall, running on an EVM chain.
Users bind policies on an event, oracle rounds produce an evidence interval, and policies on either
side of that interval settle in range operations rather than one by one.

Status: under construction. See [PROGRESS.md](PROGRESS.md) for what exists today.

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- npm 10+
- MetaMask in a desktop browser (for the frontend, from Milestone 5)

## Quick start

```bash
npm install
npm run compile
npm test
npm run lint
npm -w frontend run build
```

Run the local stack, and a scenario from a second terminal:

```bash
npm run dev:stack
npm run demo:cli -- --scenario compromised-feed
```

The web app (`npm run dev:web`) arrives in Milestone 5. Details are in
[docs/RUNNING.md](docs/RUNNING.md).

## Repository layout

| Path                 | Contents                                                    |
| -------------------- | ----------------------------------------------------------- |
| `contracts/`         | Solidity 0.8.24 contracts                                   |
| `test/`              | Hardhat tests                                               |
| `scripts/`           | Deploy, seed and ABI export scripts                         |
| `packages/ties-math` | TypeScript reference implementation of the settlement maths |
| `services/`          | Source servers, oracle nodes, keeper, demo server           |
| `experiments/`       | Scenarios and experiment runner                             |
| `frontend/`          | React + Vite + TypeScript web app                           |
| `docs/`              | Architecture, running, experiments, security notes          |
