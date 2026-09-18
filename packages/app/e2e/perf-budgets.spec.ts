/**
 * TSK0053 — 100 MiB performance budgets (real browser, built app).
 *
 * Run with `E2E_INCLUDE_PERF=1 pnpm test:e2e` (excluded from the default
 * PR run to keep it fast; scheduled CI runs it). Data is STREAMED from
 * the e2e fixture server (`/e2e-fixture/jsonl?bytes=…`) — nothing large
 * is committed or loaded from disk.
 *
 * The assertions are PROVISIONAL budgets: hard invariants (DOM bounds,
 * no eager parsed dataset, cancellation responsiveness) fail the test,
 * while wall-clock budgets carry wide margins until three stable runs
 * on the CI machine shape tighter numbers (docs/perf-baselines.md).
 * Every run prints a metrics table for the baselines document.
 */
import { test, expect, type Page } from '@playwright/test'

const INCLUDE_PERF = process.env['E2E_INCLUDE_PERF'] === '1'

/** 100 MiB at 256 B/row = exactly 409 600 rows. */
const MEBI = 1024 * 1024
const SOAK_BYTES = 100 * MEBI
const ROW_BYTES = 256
const EXPECTED_ROWS = SOAK_BYTES / ROW_BYTES // 409_600
/**
 * Rows whose index starts with '9': 9, 90-99, 900-999, 9000-9999,
 * 90000-99999 (max i = 409 599, so no 900 000+ matches).
 */
const FILTER_QUERY = '"i":9'
const FILTER_EXPECTED = 1 + 10 + 100 + 1000 + 10000 // 11_111
/** The status bar renders counts via formatInt (en-US grouping). */
const fmt = (n: number) => n.toLocaleString('en-US')

const BASE = 'http://localhost:4173'

function heapMB(page: Page): Promise<number> {
  return page.evaluate(() => {
    const mem = (
      performance as unknown as {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
      }
    ).memory
    return mem ? mem.usedJSHeapSize / 1048576 : -1
  })
}

/** Max number of rendered row items while scrolling top → bottom. */
async function maxDomItemsWhileScrolling(page: Page): Promise<number> {
  const scroll = page.locator('[data-testid="row-list-scroll"]')
  let max = 0
  for (let step = 0; step <= 10; step++) {
    await scroll.evaluate((el, f) => {
      el.scrollTop = el.scrollHeight * f
    }, step / 10)
    await page.waitForTimeout(250) // let the virtualizer fetch the window
    const count = await page.locator('[data-testid="row-item"]').count()
    max = Math.max(max, count)
  }
  return max
}

async function openUrl(page: Page, url: string): Promise<void> {
  await page.goto('/')
  await page.locator('[role="button"][aria-label^="File drop zone"]').waitFor()
  await page.locator('button:has-text("Open from URL")').click()
  const modal = page.locator('[role="dialog"]:has(input[type="url"])')
  await modal.waitFor()
  await modal.locator('input[type="url"]').fill(url)
  await modal.locator('button:has-text("Open")').last().click()
}

async function waitForSettled(page: Page, total: string, timeoutMs = 300_000): Promise<void> {
  await page.waitForURL(/\/explorer/, { timeout: 60_000 })
  await expect(page.locator('[data-testid="total-count"]')).toHaveText(total, {
    timeout: timeoutMs,
  })
  // expect.poll (NOT waitForFunction — this Playwright build clamps its
  // timeout to 30 s regardless of the option, TSK0053).
  await expect.poll(
    () => page.evaluate(() => !document.querySelector('[data-testid="row-placeholder"]')),
    { timeout: timeoutMs },
  ).toBe(true)
}

test.describe('100 MiB perf budgets (TSK0053)', () => {
  // Gated off the default (PR) run: streaming 100 MiB + index + filter
  // on a slow CI machine takes far longer than the 30 s default test
  // timeout. (A bare `test.skip` value and describe.configure({mode:
  // 'skip'}) were both empirically ignored by this Playwright build —
  // the conditional test.skip() hook is what actually works, TSK0053.)
  test.skip(!INCLUDE_PERF, 'perf budgets: set E2E_INCLUDE_PERF=1 to run')
  test.setTimeout(900_000)
  test.use({ viewport: { width: 1440, height: 900 } })

  test('index, filter, DOM bounds, heap, export backpressure', async ({ page }) => {
    const url = `${BASE}/e2e-fixture/jsonl?bytes=${SOAK_BYTES}&rowBytes=${ROW_BYTES}`
    const t0 = Date.now()
    await openUrl(page, url)

    // The 100 MiB stream must go DIRECTLY to OPFS (quota is not
    // exceeded) — if the in-memory-fallback consent dialog appears, the
    // OPFS path regressed; fail fast instead of waiting out the settle.
    const consent = page.locator('[data-testid="fallback-accept"]')
    await Promise.race([
      waitForSettled(page, fmt(EXPECTED_ROWS)),
      consent.waitFor({ timeout: 120_000 }).then(() => {
        throw new Error(
          'OPFS-fallback consent appeared for a 100 MiB stream — expected ' +
            'a direct OPFS stream. The OPFS path (or its quota) regressed.',
        )
      }),
    ])
    const indexMs = Date.now() - t0
    const heapAfterIndex = await heapMB(page)

    // DOM bounds while scrolling through the whole list:
    const maxItems = await maxDomItemsWhileScrolling(page)

    // Text filter over all 409 600 rows (matches exactly 11 111 rows):
    const tF0 = Date.now()
    await page.locator('[data-testid="filter-input"]').fill(FILTER_QUERY)
    await page.locator('[data-testid="filter-run"]').click()
    await expect(page.locator('[data-testid="filtered-count"]')).toHaveText(
      fmt(FILTER_EXPECTED),
      { timeout: 300_000 },
    )
    await expect.poll(
      () => page.evaluate(() => !document.querySelector('[data-testid="filter-progress"]')),
      { timeout: 300_000 },
    ).toBe(true)
    const filterMs = Date.now() - tF0
    const heapAfterFilter = await heapMB(page)

    // Export backpressure: stream the 11 111-row filtered view through
    // the FSA pipeline (mocked writable). The mock must be installed on
    // the LIVE page (addInitScript only affects fresh navigations),
    // before the export pipeline lazily calls showSaveFilePicker.
    await page.evaluate(() => {
      const w = window as unknown as {
        __fsaClosed?: boolean
        __fsaBytes?: number
        showSaveFilePicker?: (o?: { suggestedName?: string }) => Promise<unknown>
      }
      w.__fsaBytes = 0
      w.showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: async (data: Uint8Array) => {
            w.__fsaBytes = (w.__fsaBytes ?? 0) + data.length
          },
          close: async () => {
            w.__fsaClosed = true
          },
          abort: async () => undefined,
        }),
      })
    })
    const heapBeforeExport = await heapMB(page)
    const tE0 = Date.now()
    await page.locator('[data-testid="export-button"]').click()
    await expect.poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __fsaClosed?: boolean }).__fsaClosed === true,
        ),
      { timeout: 300_000 },
    ).toBe(true)
    const exportMs = Date.now() - tE0
    const exportedBytes = await page.evaluate(
      () => (window as unknown as { __fsaBytes?: number }).__fsaBytes ?? 0,
    )
    const heapAfterExport = await heapMB(page)

    console.log(
      `\n=== TSK0053 perf budgets (100 MiB / ${fmt(EXPECTED_ROWS)} rows) ===\n` +
        `index:      ${Math.round(indexMs)} ms\n` +
        `filter:     ${Math.round(filterMs)} ms (${fmt(FILTER_EXPECTED)} matches)\n` +
        `rows:       ${fmt(EXPECTED_ROWS)} indexed\n` +
        `export:     ${Math.round(exportMs)} ms (${exportedBytes} bytes via FSA chunks)\n` +
        `heap:       index=${heapAfterIndex.toFixed(0)} MiB, filter=${heapAfterFilter.toFixed(0)} MiB, ` +
        `export ${heapBeforeExport.toFixed(0)}→${heapAfterExport.toFixed(0)} MiB\n` +
        `dom rows:   max ${maxItems} rendered items\n`,
    )

    // ---- hard invariants -------------------------------------------------
    // Virtualization: a bounded DOM no matter how far the user scrolls.
    expect(
      maxItems,
      'DOM row items must stay bounded (virtualization)',
    ).toBeLessThanOrEqual(256)
    // No eager parsed dataset: heap must not scale with file size.
    // 100 MiB of raw bytes + a parsed JS object graph would dwarf this.
    expect(
      heapAfterIndex,
      'heap after index must not scale with file size',
    ).toBeLessThan(1536)
    expect(
      heapAfterExport - heapBeforeExport,
      'export heap growth must stay bounded (backpressure)',
    ).toBeLessThan(512)
    // The export delivered exactly the filtered rows (256 bytes each).
    expect(exportedBytes).toBe(FILTER_EXPECTED * ROW_BYTES)

    // ---- provisional wall-clock budgets (wide margins) -------------------
    expect(indexMs, '100 MiB index budget').toBeLessThan(120_000)
    expect(filterMs, '400k-row filter budget').toBeLessThan(120_000)
    expect(exportMs, '11k-row export budget').toBeLessThan(120_000)
  })

  test('cancellation latency on a slow 600 MiB stream', async ({ page }) => {
    // 600 MiB at 2 KiB/150 ms ≈ 83 minutes — we cancel long before that.
    const url = `${BASE}/e2e-fixture/jsonl?bytes=${600 * MEBI}&rowBytes=${ROW_BYTES}&delayMs=150`
    await openUrl(page, url)
    const cancel = page.locator('[data-testid="loading-cancel"]')
    await expect(cancel).toBeVisible({ timeout: 30_000 })
    const t0 = Date.now()
    await cancel.click()
    // The in-modal loading panel disappears and the form is kept
    // (retryable) — that is the cancellation landing.
    await expect(cancel).toHaveCount(0, { timeout: 15_000 })
    const cancelMs = Date.now() - t0
    console.log(`\n=== TSK0053 cancellation ===\ncancel:  ${Math.round(cancelMs)} ms to settled\n`)

    // Cancellation must be prompt: the download + spool cleanup is
    // aborted, not drained. (Wide margin: CI machines are slow.)
    expect(cancelMs, 'cancellation budget').toBeLessThan(10_000)
    // No partial file was loaded: still on the landing page, no explorer.
    await expect(page).toHaveURL('/')
  })
})
