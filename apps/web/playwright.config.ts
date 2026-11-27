import { defineConfig, devices } from "@playwright/test";

// Runs against the already-running compose stack:
//   docker compose -f compose.yml -f compose.e2e.yml up -d --build
// The stack keeps its state, so run against a fresh one (`docker compose down -v` first) for a clean pass.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.WEB_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
