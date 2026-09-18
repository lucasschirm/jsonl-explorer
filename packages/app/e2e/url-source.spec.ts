/**
 * TSK0046 — URL SOURCE E2E (real browser, built app) against the
 * generated `/e2e-fixture/*` endpoints of the e2e front server:
 *
 * - plain load, slow stream (progress + completion), HTTP errors,
 *   redirect chains, gzip with a LYING content-length;
 * - a genuinely cross-origin server WITHOUT CORS headers must produce a
 *   VISIBLE failure (typed toast), never a silent console error;
 * - cancel of a slow load keeps the form for an in-place retry;
 * - custom headers reach the server (asserted via the /headers echo).
 */
import { test, expect, type Page } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const BASE = 'http://localhost:4173'
let corsServer: http.Server
let corsPort = 0

test.beforeAll(async () => {
  // A real second origin serving JSONL with NO CORS headers.
  corsServer = http.createServer((req, res) => {
    if (req.url === '/data.jsonl') {
      res.writeHead(200, { 'content-type': 'application/jsonl' })
      res.end('{"cors":"should-not-be-readable"}\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => corsServer.listen(0, '127.0.0.1', () => resolve()))
  corsPort = (corsServer.address() as AddressInfo).port
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => corsServer.close(() => resolve()))
})

async function openUrl(
  page: Page,
  url: string,
  extraHeaders?: { key: string; value: string }[],
): Promise<void> {
  await page.goto('/')
  await page.locator('button:has-text("Open from URL")').click()
  const modal = page.locator('.modal[role="dialog"]')
  await expect(modal).toBeVisible()
  await modal.locator('input[type="url"]').fill(url)
  // One starter header row exists; "Add" appends more.
  for (let i = 0; i < (extraHeaders?.length ?? 0); i++) {
    if (i > 0) await modal.locator('button:has-text("Add")').click()
    const header = extraHeaders![i]!
    await modal
      .locator('input[placeholder="Header name (e.g., Authorization)"]')
      .nth(i)
      .fill(header.key)
    await modal.locator('input[placeholder="Header value"]').nth(i).fill(header.value)
  }
  await modal.locator('button:has-text("Open")').click()
}

async function expectExplorer(page: Page, total: string): Promise<void> {
  await expect(page).toHaveURL(/\/explorer/, { timeout: 30_000 })
  await expect(page.locator('[data-testid="total-count"]')).toHaveText(total, { timeout: 30_000 })
}

test.describe('URL source (TSK0046)', () => {
  test('modal load: generated JSONL is indexed', async ({ page }) => {
    await openUrl(page, `${BASE}/e2e-fixture/jsonl?rows=5`)
    await expectExplorer(page, '5')
    await expect(page.locator('[data-testid="filtered-count"]')).toHaveText('5')
  })

  test('slow stream: progress visible while downloading, then completes', async ({ page }) => {
    await page.goto('/')
    await page.locator('button:has-text("Open from URL")').click()
    const modal = page.locator('.modal[role="dialog"]')
    await modal.locator('input[type="url"]').fill(`${BASE}/e2e-fixture/jsonl?rows=200&delayMs=150`)
    await modal.locator('button:has-text("Open")').click()

    // The in-modal loading panel offers cancel while the stream drips in.
    await expect(page.locator('[data-testid="loading-cancel"]')).toBeVisible({ timeout: 15_000 })
    await expectExplorer(page, '200')
  })

  test('HTTP 500: visible toast, modal + URL preserved for retry', async ({ page }) => {
    await openUrl(page, `${BASE}/e2e-fixture/error?status=500`)
    const toast = page.locator('div[role="alert"]', { hasText: 'URL load failed' })
    await expect(toast).toBeVisible({ timeout: 15_000 })
    // The modal stayed open with the entered URL (in-place retry).
    const modal = page.locator('.modal[role="dialog"]')
    await expect(modal).toBeVisible()
    await expect(modal.locator('input[type="url"]')).toHaveValue(`${BASE}/e2e-fixture/error?status=500`)
  })

  test('redirect chain is followed to the JSONL target', async ({ page }) => {
    await openUrl(page, `${BASE}/e2e-fixture/redirect?to=${encodeURIComponent(`${BASE}/e2e-fixture/jsonl?rows=3`)}&hops=2`)
    await expectExplorer(page, '3')
  })

  test('lying content-length (server under-reports): truncated transfer indexed cleanly, no hang', async ({
    page,
  }) => {
    // The fixture advertises HALF the body size (a buggy server) while
    // writing the full body; a well-behaved client stops at the declared
    // Content-Length. The scanner commits every LF-terminated row AND a
    // final non-LF-terminated tail row (commitFinalRow) — so the partial
    // tail is VISIBLE (as an invalid-JSON row), not silently dropped, and
    // the load settles (no hang, no error toast). Expected count mirrors
    // e2e-server.mjs fixtureRow.
    const rows: string[] = []
    for (let i = 0; i < 50; i++) rows.push(`{"i":${i},"pad":"${'x'.repeat(48)}"}`)
    const body = rows.join('\n') + '\n'
    const half = body.slice(0, Math.floor(body.length / 2))
    const expected = String((half.match(/\n/g) ?? []).length + 1) // + final partial row
    await openUrl(page, `${BASE}/e2e-fixture/jsonl?rows=50&lie-length=1`)
    await expectExplorer(page, expected)
    await expect(page.locator('[data-testid="filtered-count"]')).toHaveText(expected)
  })

  test('gzip transfer loads all rows (transparent decode)', async ({ page }) => {
    await openUrl(page, `${BASE}/e2e-fixture/jsonl?rows=50&gzip=1`)
    await expectExplorer(page, '50')
  })

  test('cross-origin load without CORS: visible typed failure, no silent error', async ({ page }) => {
    const silentErrors: string[] = []
    page.on('pageerror', (err) => silentErrors.push(err.message))

    await openUrl(page, `http://127.0.0.1:${corsPort}/data.jsonl`)
    const toast = page.locator('div[role="alert"]', { hasText: 'URL load failed' })
    await expect(toast).toBeVisible({ timeout: 15_000 })
    // Still on landing — nothing half-loaded.
    await expect(page).toHaveURL(/\/$/)
    // No uncaught page errors either: the failure is fully handled.
    expect(silentErrors).toEqual([])
  })

  test('cancel a slow load: info toast, form kept, no explorer', async ({ page }) => {
    await page.goto('/')
    await page.locator('button:has-text("Open from URL")').click()
    const modal = page.locator('.modal[role="dialog"]')
    await modal.locator('input[type="url"]').fill(`${BASE}/e2e-fixture/jsonl?rows=2000&delayMs=120`)
    await modal.locator('button:has-text("Open")').click()

    await expect(page.locator('[data-testid="loading-cancel"]')).toBeVisible({ timeout: 15_000 })
    await page.locator('[data-testid="loading-cancel"]').click()

    await expect(page.locator('div[role="alert"]', { hasText: 'Load cancelled' })).toBeVisible()
    // Form preserved for an in-place retry.
    await expect(modal).toBeVisible()
    await expect(modal.locator('input[type="url"]')).toHaveValue(`${BASE}/e2e-fixture/jsonl?rows=2000&delayMs=120`)
  })

  test('custom headers reach the server (header echo)', async ({ page }) => {
    await openUrl(page, `${BASE}/e2e-fixture/headers`, [{ key: 'x-test-marker', value: 'journey-e2e' }])
    // The echo is a single JSON row: {"headers":[...]}
    await expectExplorer(page, '1')
    await expect(page.locator('[data-testid="detail-panel"]')).toContainText('x-test-marker')
    await expect(page.locator('[data-testid="detail-panel"]')).toContainText('journey-e2e')
  })
})
