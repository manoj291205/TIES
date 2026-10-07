# Running TIES

## Requirements

- Node.js 22 (`nvm use` reads `.nvmrc`)
- npm 10+

## Install and check

```bash
npm install
npm run lint
npm run compile
npm test
npm -w frontend run build
```

## Local chain, services and web app

Added in later milestones:

- `npm run dev:stack`: Hardhat node, deploy, seed, sources, oracle nodes, keeper, demo server (M4)
- `npm run dev:web`: the frontend (M5)

## Configuration

Copy `.env.example` to `.env` only when deploying to a public network. Local development needs no
secrets. Never commit `.env`.
