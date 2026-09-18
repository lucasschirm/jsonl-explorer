/**
 * TSK0053 — multi-GB soak run (real browser, built app, streamed data).
 *
 * Streams a large JSONL transfer (default 2 GiB) from the e2e fixture
 * server into the app, then exercises the same paths as the 100 MiB
 * perf budgets (filter, DOM bounds, export backpressure, cancellation)
 * at a scale that only the OPFS-backed pipeline can hold. Everything
 * large is generated on the fly — nothing is committed or read from
 * disk, and the browser profile (with its OPFS data) is deleted after
 * the run.
 *
 * Usage:
 *   node scripts/perf-soak.mjs
 * Env:
 *   SOAK_BYTES        total stream size in bytes (default 2 GiB)
 *   SOAK_ROW_BYTES    row size in bytes (default 256)
 *   SOAK_DELAY_MS     fixture pacing, ms per 2 KiB (default 0)
 *   SOAK_PORT         e2e-server port (default 4173)
 *   SOAK_ARTIFACT_DIR artifact output dir (default packages/app/artifacts)
 *   SOAK_KEEP_PROFILE keep the browser profile dir (default: deleted)
 *
 * Output: a JSON artifact (metrics + machine/browser info + invariant
 * verdicts). Exits non-zero when a HARD invariant fails (see buildInvariants);
 * reference metrics are reported but never gate.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))

const GIB = 1024 ** 3
const MEBI = 1024 ** 2
const SOAK_BYTES = Number(process.env['SOAK_BYTES'] ?? 2 * GIB)
const ROW_BYTES = Number(process.env['SOAK_ROW_BYTES'] ?? 256)
const DELAY_MS = Number(process.env['SOAK_DELAY_MS'] ?? 0)
const PORT = Number(process.env['SOAK_PORT'] ?? 4173)
const ARTIFACT_DIR = process.env['SOAK_ARTIFACT_DIR'] ?? join(here, '..', 'artifacts')
const KEEP_PROFILE = process.env['SOAK_KEEP_PROFILE'] === '1'
const BASE = `http://127.0.0.1:${PORT}`

/** PROVISIONAL budgets (TSK0053) — wide margins until stable CI runs. */
const BUDGETS = { indexMs: 900_000, filterMs: 600_000, exportMs: 600_000, cancelMs: 30_000 }

function log(msg) {
  console.log(`[soak] ${msg}`)
}

/**
 * How many row indices in [0, rows) render as a decimal starting with
 * '9' (9, 90-99, 900-999, …) — the deterministic text-filter expectation
 * for the fixture rows (`"i":9` matches exactly those).
 */
export function countStartingWithNine(rows) {
  let count = 0
  for (let digits = 1; digits <= String(Math.max(rows - 1, 1)).length; digits++) {
    const lo = 10 ** (digits - 1)
    const start = lo * 9
    const end = Math.min(lo * 9 + lo - 1, rows - 1)
    if (end >= start) count += end - start + 1
  }
  return count
}

/** Waits until the e2e-server answers on its port. */
function waitForServer(port, timeoutMs = 60_000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(`http://127.0.0.1:${port}/e2e-fixture/jsonl?rows=1`, (res) => {
        res.resume()
        res.once('end', () => resolve())
      })
      req.once('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`e2e-server did not come up on :${port}`))
        } else {
          setTimeout(probe, 500)
        }
      })
    }
    probe()
  })
}

/** Spawns the e2e-server (fixture endpoints + nitro front) for the run. */
function startServer() {
  return spawn('node', [join(here, 'e2e-server.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
}

function heapMB(page) {
  return page.evaluate(() => {
    const mem = performance.memory
    return mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1
  })
}

/** Max number of rendered row items while scrolling top → bottom. */
async function maxDomItemsWhileScrolling(page) {
  const scroll = page.locator('[data-testid="row-list-scroll"]')
  let max = 0
  for (let step = 0; step <= 10; step++) {
    await scroll.evaluate((el, f) => {
      el.scrollTop = el.scrollHeight * f
    }, step / 10)
    await page.waitForTimeout(300) // let the virtualizer fetch the window
    max = Math.max(max, await page.locator('[data-testid="row-item"]').count())
  }
  return max
}

async function openUrl(page, url) {
  // Absolute: a raw (non-runner) context has no baseURL for '/'.
  await page.goto(BASE)
  await page.locator('[role="button"][aria-label^="File drop zone"]').waitFor()
  await page.locator('button:has-text("Open from URL")').click()
  const modal = page.locator('[role="dialog"]:has(input[type="url"])')
  await modal.waitFor()
  await modal.locator('input[type="url"]').fill(url)
  await modal.locator('button:has-text("Open")').last().click()
}

/**
 * Polls a page predicate until true or the deadline. NOT page.
 * waitForFunction: this Playwright build ignores its { timeout } option
 * and clamps to 30 s (verified empirically, TSK0053), which is far too
 * short for multi-GB scans.
 */
async function waitUntil(page, predicate, arg, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let ok = false
    try {
      ok = arg === undefined ? await page.evaluate(predicate) : await page.evaluate(predicate, arg)
    } catch {
      ok = false // transient (navigation in flight) — keep polling
    }
    if (ok) return
    if (Date.now() > deadline) {
      throw new Error(`${what}: not true within ${Math.round(timeoutMs / 1000)}s`)
    }
    await page.waitForTimeout(500)
  }
}

/** Waits for index completion; fails if the fallback consent appears. */
async function waitForSettled(page, totalLabel, timeoutMs) {
  const consent = page.locator('[data-testid="fallback-accept"]')
  await Promise.race([
    (async () => {
      await page.waitForURL(/\/explorer/, { timeout: 120_000 })
      await waitUntil(
        page,
        (t) =>
          document.querySelector('[data-testid="total-count"]')?.textContent === t &&
          !document.querySelector('[data-testid="row-placeholder"]'),
        totalLabel,
        timeoutMs,
        `index did not settle on "${totalLabel}" rows`,
      )
    })(),
    consent.waitFor({ timeout: timeoutMs }).then(() => {
      throw new Error('OPFS-fallback consent appeared — the OPFS stream path regressed')
    }),
  ])
}

/** Deletes every entry under the OPFS root (soak cleanup). */
async function clearOpfs(page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const keys = []
    for await (const [name] of root.entries()) keys.push(name)
    for (const name of keys) {
      try {
        await root.removeEntry(name, { recursive: true })
      } catch (err) {
        // NotFound: the app's own session cleanup (e.g. after the
        // cancellation probe) already removed it — that is success.
        if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err
      }
    }
  })
}

async function storageEstimate(page) {
  return page.evaluate(async () => {
    const est = await navigator.storage.estimate()
    return { usage: Number(est.usage ?? 0), quota: Number(est.quota ?? 0) }
  })
}

async function runFilterAndExport(page, filterExpected) {
  const tF0 = Date.now()
  await page.locator('[data-testid="filter-input"]').fill('"i":9')
  await page.locator('[data-testid="filter-run"]').click()
  log(`filter: waiting for ${filterExpected.toLocaleString('en-US')} matches…`)
  await waitUntil(
    page,
    (t) =>
      document.querySelector('[data-testid="filtered-count"]')?.textContent === t,
    filterExpected.toLocaleString('en-US'),
    3_600_000,
    'filter count did not settle',
  )
  log('filter: count settled, waiting for progress to clear…')
  await waitUntil(
    page,
    () => !document.querySelector('[data-testid="filter-progress"]'),
    undefined,
    3_600_000,
    'filter progress never cleared',
  )
  const filterMs = Date.now() - tF0
  const heapAfterFilter = await heapMB(page)

  // Export the filtered view through the (mocked) FSA pipeline: a
  // runaway pump would show up as a stall or unbounded heap growth.
  await page.evaluate(() => {
    const w = window
    w.__fsaBytes = 0
    w.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (data) => {
          w.__fsaBytes += data.length
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
  await waitUntil(
    page,
    () => window.__fsaClosed === true,
    undefined,
    3_600_000,
    'export (FSA writable) never closed',
  )
  const exportMs = Date.now() - tE0
  const exportedBytes = await page.evaluate(() => window.__fsaBytes ?? 0)
  const heapAfterExport = await heapMB(page)
  return { filterMs, exportMs, exportedBytes, heapAfterFilter, heapBeforeExport, heapAfterExport }
}

/** The full 2 GiB-scale exercise: index, DOM, filter, export, OPFS. */
async function runSoak(page, url, expectedRows) {
  const t0 = Date.now()
  await openUrl(page, url)
  log('waiting for index to settle…')
  await waitForSettled(page, expectedRows.toLocaleString('en-US'), 3_600_000)
  log('settled')
  const indexMs = Date.now() - t0
  const heapAfterIndex = await heapMB(page)
  const estimateBefore = await storageEstimate(page)

  log('scrolling…')
  const maxItems = await maxDomItemsWhileScrolling(page)
  log('filter + export…')
  const filterExport = await runFilterAndExport(page, countStartingWithNine(expectedRows))
  const estimateAfter = await storageEstimate(page)

  return {
    indexMs,
    heapAfterIndex,
    maxItems,
    ...filterExport,
    opfsUsageBefore: estimateBefore.usage,
    opfsQuota: estimateBefore.quota,
    opfsUsageAfter: estimateAfter.usage,
  }
}

/** Cancellation: start the slow stream, cancel, measure the settle. */
async function runCancellation(page) {
  const url = `${BASE}/e2e-fixture/jsonl?bytes=${SOAK_BYTES}&rowBytes=${ROW_BYTES}&delayMs=150`
  await openUrl(page, url)
  const cancel = page.locator('[data-testid="loading-cancel"]')
  await cancel.waitFor({ state: 'visible', timeout: 120_000 })
  const t0 = Date.now()
  await cancel.click()
  await cancel.waitFor({ state: 'detached', timeout: 60_000 })
  // No navigation happens (the modal stays on the landing page) — check
  // the URL directly; waitForURL would wait for a load that never comes.
  if (!page.url().startsWith(BASE + '/')) {
    throw new Error(`unexpected URL after cancel: ${page.url()}`)
  }
  return Date.now() - t0
}

function buildInvariants(metrics, cancelMs, expectedRows) {
  const check = (name, ok, detail) => ({ name, ok, detail })
  return [
    check('index completed with the exact row count', true, `${expectedRows} rows`),
    check(
      'DOM stayed bounded while scrolling (virtualization)',
      metrics.maxItems <= 512,
      `max ${metrics.maxItems} row items`,
    ),
    check(
      'main-thread heap stayed bounded after index',
      metrics.heapAfterIndex < 1536,
      `${metrics.heapAfterIndex} MiB`,
    ),
    check(
      'export delivered exactly the filtered bytes',
      metrics.exportedBytes === countStartingWithNine(expectedRows) * ROW_BYTES,
      `${metrics.exportedBytes} bytes`,
    ),
    check('cancellation settled promptly', cancelMs < BUDGETS.cancelMs, `${cancelMs} ms`),
  ]
}

async function launchBrowser(chromium, profileDir) {
  return chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1440, height: 900 },
  })
}

async function main() {
  if (ROW_BYTES < 64) throw new Error('SOAK_ROW_BYTES must be >= 64 (row overhead)')
  const expectedRows = Math.ceil(SOAK_BYTES / ROW_BYTES)
  const soakUrl =
    `${BASE}/e2e-fixture/jsonl?bytes=${SOAK_BYTES}&rowBytes=${ROW_BYTES}` +
    (DELAY_MS ? `&delayMs=${DELAY_MS}` : '')

  const child = startServer()
  let profileDir = ''
  let exitCode = 1
  try {
    await waitForServer(PORT)
    const { chromium } = await import('@playwright/test')
    profileDir = join(tmpdir(), `jsonl-soak-${Date.now()}`)
    const context = await launchBrowser(chromium, profileDir)
    const page = await context.newPage()

    log(`streaming ${SOAK_BYTES / GIB} GiB (${expectedRows} rows) into the app…`)
    const metrics = await runSoak(page, soakUrl, expectedRows)

    log('cancellation probe…')
    const cancelMs = await runCancellation(page)

    log('cleaning OPFS…')
    await clearOpfs(page)
    const opfsUsageAfterCleanup = (await storageEstimate(page)).usage

    const invariants = buildInvariants(metrics, cancelMs, expectedRows)
    const artifact = {
      tool: 'perf-soak',
      task: 'TSK0053',
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      browser: chromium.name(),
      config: { soakBytes: SOAK_BYTES, rowBytes: ROW_BYTES, delayMs: DELAY_MS },
      metrics: { ...metrics, cancelMs, opfsUsageAfterCleanup },
      invariants,
      budgets: BUDGETS,
    }
    mkdirSync(ARTIFACT_DIR, { recursive: true })
    const artifactPath = join(ARTIFACT_DIR, `perf-soak-${Date.now()}.json`)
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n')

    for (const i of invariants) log(`${i.ok ? 'PASS' : 'FAIL'}  ${i.name} — ${i.detail}`)
    log(`artifact: ${artifactPath}`)
    exitCode = invariants.every((i) => i.ok) ? 0 : 1
    await context.close()
  } finally {
    child.kill('SIGTERM')
    if (profileDir && !KEEP_PROFILE) rmSync(profileDir, { recursive: true, force: true })
  }
  process.exit(exitCode)
}

main().catch((err) => {
  console.error(`[soak] FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
