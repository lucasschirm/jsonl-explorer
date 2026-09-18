/**
 * TSK0047 — OPFS STORAGE E2E (real browser, real OPFS).
 *
 * - a URL load spools into REAL OPFS part files; "open another file"
 *   disposes the engine and removes EVERY spool artifact from the origin;
 * - an injected quota failure (declared size over the estimated quota)
 *   falls back to paged memory — no part file is ever written;
 * - an injected OPFS-unavailable failure triggers the VISIBLE consent
 *   handshake: reject → typed failure (no explorer); accept → memory
 *   fallback loads the rows.
 *
 * The injections target the WORKER (it owns the download and the spool —
 * page-context stubs cannot reach it): the worker script is rewritten via
 * route interception with a top-level `navigator.storage` override. The
 * marker string is worker-only (the main bundle shares the protocol
 * strings, so they cannot identify the worker).
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = 'http://localhost:4173'

/**
 * Prepends `stub` to the worker script (identified by a worker-only
 * string) so it runs in the worker's own context, before any download.
 */
async function stubWorkerStorage(page: Page, stub: string): Promise<void> {
  await page.route('**/_nuxt/*.js', async (route) => {
    const response = await route.fetch()
    const body = await response.text()
    const isWorker = body.includes('Spool source returned an empty read')
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: isWorker ? `${stub}\n${body}` : body,
    })
  })
}

/** Enumerate the origin's OPFS root (spool artifacts live here). */
async function opfsNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const out: string[] = []
    const it = root.keys()
    for (;;) {
      const r = await it.next()
      if (r.done) break
      out.push(r.value)
    }
    return out
  })
}

const spoolNames = (names: string[]) => names.filter((n) => n.startsWith('spool-'))

async function openUrl(page: Page, url: string): Promise<void> {
  await page.goto(`${BASE}/`)
  await page.locator('button:has-text("Open from URL")').click()
  const modal = page.locator('.modal[role="dialog"]')
  await expect(modal).toBeVisible()
  await modal.locator('input[type="url"]').fill(url)
  await modal.locator('button:has-text("Open")').click()
}

test.describe('OPFS storage (TSK0047)', () => {
  test('URL load spools into OPFS; reset removes every artifact', async ({ page }) => {
    // 20k rows ≈ 1.36 MB → at least one immutable 1 MiB part file.
    await openUrl(page, `${BASE}/e2e-fixture/jsonl?rows=20000`)
    await expect(page.locator('[data-testid="total-count"]')).toHaveText('20,000', { timeout: 30_000 })

    const whileLoaded = spoolNames(await opfsNames(page))
    expect(whileLoaded.length).toBeGreaterThan(0)

    // "Open another file" disposes the engine (worker + spool).
    await page.locator('[data-testid="upload-another"]').click()
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 })

    const afterReset = spoolNames(await opfsNames(page))
    expect(afterReset).toEqual([])
  })

  test('quota failure: declared size over estimated quota → memory fallback, no part files', async ({
    page,
  }) => {
    // ~128 KiB available in the WORKER; the 20k-row fixture declares
    // ≈1.36 MB — far over quota. The OPFS path would have written at
    // least one 1 MiB part; the memory fallback writes none.
    await stubWorkerStorage(
      page,
      `Object.defineProperty(navigator.storage, 'estimate', { value: async () => ({ usage: 100 * 1024 * 1024 - 128 * 1024, quota: 100 * 1024 * 1024 }), configurable: true })`,
    )

    await openUrl(page, `${BASE}/e2e-fixture/jsonl?rows=20000`)
    await expect(page.locator('[data-testid="total-count"]')).toHaveText('20,000', { timeout: 30_000 })

    // Small declared sizes fall back to memory silently by design (no
    // consent under the 100 MiB threshold); the load still completes.
    expect(spoolNames(await opfsNames(page))).toEqual([])
  })

  test('OPFS unavailable: visible consent — reject fails typed, accept loads from memory', async ({
    page,
  }) => {
    // Force the OPFS-unavailable path IN THE WORKER: getDirectory throws.
    await stubWorkerStorage(
      page,
      `Object.defineProperty(navigator.storage, 'getDirectory', { value: () => Promise.reject(new Error('injected: no OPFS')), configurable: true })`,
    )

    // First attempt: REJECT the consent → typed failure, no explorer.
    // chunked=1: no Content-Length → size unknown → the memory fallback
    // REQUIRES the consent handshake (small declared sizes fall back
    // silently by design).
    await openUrl(page, `${BASE}/e2e-fixture/jsonl?rows=3000&chunked=1`)
    const consent = page.locator('[data-testid="fallback-accept"]')
    await expect(consent).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-testid="fallback-reject"]').click()
    const toast = page.locator('div[role="alert"]', { hasText: 'URL load failed' })
    await expect(toast).toBeVisible({ timeout: 15_000 })
    await expect(page).not.toHaveURL(/\/explorer/)
    expect(spoolNames(await opfsNames(page))).toEqual([])

    // The modal survives for an in-place retry (URL preserved).
    const modal = page.locator('.modal[role="dialog"]')
    await expect(modal).toBeVisible()
    await expect(modal.locator('input[type="url"]')).toHaveValue(
      `${BASE}/e2e-fixture/jsonl?rows=3000&chunked=1`,
    )

    // Second attempt: ACCEPT → memory fallback loads all rows.
    await modal.locator('button:has-text("Open")').click()
    await expect(page.locator('[data-testid="fallback-accept"]')).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-testid="fallback-accept"]').click()
    await expect(page).toHaveURL(/\/explorer/, { timeout: 30_000 })
    await expect(page.locator('[data-testid="total-count"]')).toHaveText('3,000', { timeout: 30_000 })
  })
})
