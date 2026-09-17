import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E (TSK0036 onward): runs against the BUILT app served by
 * `nuxi preview` (R9 — Playwright needs a web server; dev mode is never
 * used). The app must be built first (`pnpm build:app`); the root
 * `pnpm ci` sequence does build -> test:e2e.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec nuxi preview --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
})
