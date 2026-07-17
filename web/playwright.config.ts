// Playwright E2E config for AUTOMO's web UI. What's actually testable in CI is everything BEFORE a model
// connection — the onboarding gate, layout, responsiveness, copy affordances — since a headless runner has
// no local Ollama over LNA. Tests run against the REAL production bundle: webServer builds with a root base
// path (the Pages build uses /lna/) and serves web/dist via tests/preview.ts.
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const CI = !!process.env.CI;
// Dev-mode escape hatch: point tests at an already-running server (e.g. `bun run dev`) and skip the
// build+serve entirely — `E2E_BASE_URL=http://localhost:3000 bun run test:e2e`. Default targets the
// production bundle served by tests/preview.ts for deterministic runs (and CI).
const externalBase = process.env.E2E_BASE_URL;
const baseURL = externalBase ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: CI,                 // fail CI if a stray test.only was committed
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    trace: "on-first-retry",       // full trace (DOM/network/console) on the first retry
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [
    // clipboard perms are Chromium-only (WebKit throws on them), so they live on the Chromium projects.
    { name: "chromium", use: { ...devices["Desktop Chrome"], permissions: ["clipboard-read", "clipboard-write"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 5"], permissions: ["clipboard-read", "clipboard-write"] } }, // the gate clip bug was viewport-driven
    { name: "webkit", use: { ...devices["Desktop Safari"] } }, // cross-engine render check of the static UI
  ],
  // Build the app at the root base path, then serve the bundle. Playwright waits for the URL before tests.
  // Skip the build+serve when pointed at an external server (dev mode); otherwise build the production
  // bundle at a root base path and serve web/dist.
  webServer: externalBase ? undefined : {
    command: `PUBLIC_PATH=/ bun run build && PORT=${PORT} bun run ./tests/preview.ts`,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
