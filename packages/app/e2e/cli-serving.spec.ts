/**
 * TSK0047 — CLI SERVING SECURITY E2E (real browser + real CLI).
 *
 * - local mode: the CLI-served explorer bootstraps and reads the
 *   capability file in a real browser (the authorized path);
 * - local mode: a page on a DIFFERENT loopback origin cannot read the
 *   capability file (CORS denial, visible in the browser, 403 at the
 *   server — the capability is authorization, CORS is convenience);
 * - remote mode: preflight grants ONLY the hosted origin, and carries
 *   the Private-Network-Access header (server-level — the hosted app is
 *   out of reach in e2e).
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { launchCli, findFreePort, type CliHandle } from './helpers/cli'

const here = dirname(fileURLToPath(import.meta.url))
const JOURNEYS = join(here, 'fixtures', 'journeys.jsonl')
const HOSTED_ORIGIN = 'https://jsonlexplorer.lucasschirm.com'
/** The Playwright webServer (scripts/e2e-server.mjs) — a different origin than any CLI port. */
const FIXTURE_SERVER = 'http://127.0.0.1:4173'

/** Raw node:http request (full control over forbidden headers like Origin; http.get would force GET). */
function httpRequest(
  url: string,
  headers: Record<string, string>,
  method: 'GET' | 'OPTIONS' = 'GET',
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      // Drain so the socket can be reused/closed cleanly.
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function withCli(
  local: boolean,
  fn: (cli: CliHandle) => Promise<void>,
): Promise<void> {
  const cli = await launchCli(JOURNEYS, await findFreePort(), { local })
  try {
    await fn(cli)
  } finally {
    await cli.close()
  }
}

test.describe('CLI serving security (TSK0047)', () => {
  test('local mode: explorer bootstraps and reads the capability file', async ({ page }) => {
    await withCli(true, async (cli) => {
      await page.goto(cli.explorerUrl, { waitUntil: 'domcontentloaded' })
      await expect(page).toHaveURL(/\/explorer/, { timeout: 30_000 })
      await expect(page.locator('[data-testid="total-count"]')).toHaveText('5', { timeout: 30_000 })
    })
  })

  test('local mode: direct routes serve the SPA (hard refresh works)', async ({ page }) => {
    // TSK0054: /explorer and /docs/<slug> have no file in the staged site;
    // the CLI's SPA fallback must serve the shell so the client router
    // renders them (a hard refresh on a deep link used to 404).
    await withCli(true, async (cli) => {
      await page.goto(`${cli.baseUrl}/docs/getting-started`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('h1')).toContainText(/getting started/i, { timeout: 30_000 })

      // The explorer deep link serves the shell; with no file loaded the
      // app boots and redirects to the landing page (its designed guard).
      await page.goto(`${cli.baseUrl}/explorer`, { waitUntil: 'domcontentloaded' })
      await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
      await page.locator('[role="button"][aria-label^="File drop zone"]').waitFor()

      // Asset-looking paths stay HARD 404s (no SPA shell for them).
      const missing = await httpRequest(`${cli.baseUrl}/definitely-missing.png`, {})
      expect(missing.status).toBe(404)

      // The served site carries the app's full CSP (shared source of
      // truth), not a bare frame-ancestors stub.
      const home = await httpRequest(`${cli.baseUrl}/`, {})
      expect(home.status).toBe(200)
      expect(home.headers['content-security-policy']).toContain("frame-ancestors 'self'")
      expect(home.headers['content-security-policy']).toContain("worker-src 'self' blob:")
      expect(home.headers['referrer-policy']).toBe('no-referrer')
    })
  })

  test('local mode: a different origin cannot read the capability file', async ({ page }) => {
    await withCli(true, async (cli) => {
      // Hostile probe page on the fixture server's origin (4173 ≠ CLI port).
      await page.goto(`${FIXTURE_SERVER}/e2e-host/cli-probe.html?target=${encodeURIComponent(cli.fileUrl)}`)
      const result = page.locator('[data-testid="probe-result"]')
      await expect(result).toContainText(/blocked/i, { timeout: 15_000 })
      // The body never leaks.
      await expect(result).not.toContainText('"name"')

      // Server-level: that origin gets an explicit 403 with NO CORS grant.
      const res = await httpRequest(cli.fileUrl, { origin: FIXTURE_SERVER })
      expect(res.status).toBe(403)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  test('remote mode: preflight grants only the hosted origin, with PNA', async () => {
    await withCli(false, async (cli) => {
      const preflight = (origin: string) =>
        httpRequest(
          cli.fileUrl,
          {
            origin,
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'range',
            'access-control-request-private-network': 'true',
          },
          'OPTIONS',
        )

      const ok = await preflight(HOSTED_ORIGIN)
      expect(ok.status).toBe(204)
      expect(ok.headers['access-control-allow-origin']).toBe(HOSTED_ORIGIN)
      expect(ok.headers['access-control-allow-private-network']).toBe('true')

      const hostile = await preflight('http://evil.example')
      expect(hostile.status).toBe(403)
      expect(hostile.headers['access-control-allow-origin']).toBeUndefined()

      // A plain GET from an untrusted origin is denied too (the capability
      // URL alone is not enough without the origin policy).
      const get = await httpRequest(cli.fileUrl, { origin: 'http://evil.example' })
      expect(get.status).toBe(403)
    })
  })
})
