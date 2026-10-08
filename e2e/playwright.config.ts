import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests of the web app against the running local stack.
 *   terminal 1: npm run dev:stack
 *   terminal 2: npm run dev:web
 *   terminal 3: npm run test:e2e
 * The suite resets the local chain first. It uses the installed Microsoft Edge; set
 * E2E_BROWSER=chrome to use Google Chrome instead.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../e2e-report" }]],
  outputDir: "../e2e-results",
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: "http://localhost:5173",
    channel: process.env.E2E_BROWSER ?? "msedge",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
