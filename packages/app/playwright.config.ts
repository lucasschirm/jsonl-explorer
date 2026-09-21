import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E (TSK0036 onward; TSK0045 infrastructure): runs against
 * the BUILT app served by the e2e front server (R9 — dev mode is never
 * used). The front server (scripts/e2e-server.mjs) fronts the real nitro
 * server, serves same-origin test fixtures under /e2e-host/*, and
 * generates controlled data endpoints under /e2e-fixture/* (slow streams,
 * chunked/misleading lengths, redirects, header echo, errors).
 *
 * The app must be built first (`pnpm build` — builds app then cli; the
 * cli is needed by e2e/helpers/cli.ts for the CLI suites).
 *
 * Projects: chromium runs the whole suite; the WebKit SMOKE subset
 * (e2e/smoke.spec.ts) runs only when E2E_INCLUDE_WEBKIT=1 (scheduled/
 * manual CI installs webkit there — PR CI stays chromium-only and fast).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? 'github' : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:4173',
    // Real download events (Blob export fallback) are asserted in tests;
    // artifacts land under test-results/<test>/downloads.
    acceptDownloads: true,
    // Failure diagnostics: trace + screenshot per failed test.
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // WebKit smoke (scheduled/manual): a small, platform-safe subset.
    ...(process.env["E2E_INCLUDE_WEBKIT"]
      ? [{ name: 'webkit', testMatch: /smoke\.spec\.ts/, use: { ...devices['Desktop Safari'] } }]
      : []),
  ],
  webServer: {
    // The real nitro server, fronted with same-origin fixtures + generated
    // data endpoints (nitro only serves public files that existed at build
    // time — the front server closes that gap without touching the app).
    command: 'node scripts/e2e-server.mjs',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
})
