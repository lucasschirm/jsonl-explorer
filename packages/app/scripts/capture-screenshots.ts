/**
 * TSK0050 — deterministic documentation screenshots.
 *
 * Captures the documented flows — landing, exploration, filtering,
 * editing, the URL modal, and the handover waiting state — in light and
 * dark at a fixed viewport, using the fixed fixture
 * `e2e/fixtures/journeys.jsonl` (5 rows, no secrets). Images are written
 * to `public/screenshots/` and referenced from the guides.
 *
 * Determinism:
 *   - pinned Chromium (via @playwright/test), fixed 1440x900 viewport,
 *     deviceScaleFactor 1, `reducedMotion: reduce` (no animations)
 *   - a FRESH page per shot (no persisted theme or state; the theme then
 *     follows the emulated `prefers-color-scheme`)
 *   - `document.fonts.ready` + a fixed settle delay before every capture
 *   - all on-screen data comes from the fixed fixture; the only dynamic
 *     values are the counts derived from it (deterministic)
 *
 * Precondition: a production build. If `.output/public` is missing the
 * script runs `pnpm build` from the repo root first.
 *
 * Cross-platform note: the committed set is rendered by CI's Linux
 * Chromium. Regenerating on another OS may produce small font
 * rasterization differences — that is expected; the Linux render is the
 * reference.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const repoRoot = join(appDir, '..')
const OUT_DIR = join(appDir, 'public', 'screenshots')
const FIXTURE = join(appDir, 'e2e', 'fixtures', 'journeys.jsonl')
const VIEWPORT = { width: 1440, height: 900 }

const SHOTS = [
  'landing',
  'exploring',
  'filtering',
  'editing',
  'url-modal',
  'handover',
] as const

function fail(message: string): never {
  console.error(`screenshot: ${message}`)
  process.exit(1)
}

/** Build the app first when no production build exists. */
function ensureBuild(): void {
  const built = join(appDir, '.output', 'public', 'index.html')
  if (existsSync(built)) return
  console.log('screenshot: no production build found — running pnpm build (this takes a while)')
  const result = spawnSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' })
  if (result.status !== 0) fail('pnpm build failed — cannot capture screenshots')
}

/** Start the static app + fixture server; resolves with its base URL. */
async function startServer(): Promise<{ base: string; stop: () => void }> {
  const server = spawn('node', [join(here, 'e2e-server.mjs')], { cwd: appDir, stdio: 'ignore' })
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch('http://127.0.0.1:4173/')
        if (res.ok) {
          clearInterval(timer)
          resolve('http://127.0.0.1:4173')
        }
      } catch {
        // not up yet
      }
    }, 200)
    setTimeout(() => {
      clearInterval(timer)
      reject(new Error('e2e-server did not start on :4173'))
    }, 30_000)
  })
  return { base, stop: () => server.kill() }
}

/** One deterministic page: fresh context, fixed viewport, themed. */
async function shotPage(browser: Browser, colorScheme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({ deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.setViewportSize(VIEWPORT)
  await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
  return page
}

/** Fonts ready, animations frozen, a fixed settle — then capture. */
async function capture(page: Page, name: string, colorScheme: 'light' | 'dark'): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  // Freeze any CSS animation/transition (e.g. the pulsing row placeholder)
  // so the capture never catches a mid-frame state.
  await page.addStyleTag({
    content: '* { animation: none !important; transition: none !important }',
  })
  await page.waitForTimeout(300)
  const file = join(OUT_DIR, `${name}-${colorScheme}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`screenshot: wrote ${file}`)
}

/** Load the fixture through the drop zone and wait for the settled list. */
async function loadFixture(page: Page, base: string): Promise<void> {
  await page.goto(base)
  await page.locator('input[type="file"]').setInputFiles({
    name: 'journeys.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: readFileSync(FIXTURE),
  })
  await page.waitForURL(`${base}/explorer`)
  await page.waitForFunction(
    (expected) => {
      const total = document.querySelector('[data-testid="total-count"]')
      return (
        total?.textContent === expected &&
        !document.querySelector('[data-testid="partial-marker"]') &&
        !document.querySelector('[data-testid="row-placeholder"]')
      )
    },
    '5',
    { timeout: 15_000 },
  )
}

/** Select a row (1-based), wait for its tree, expand `tags` when present. */
async function selectRow(page: Page, n: number): Promise<void> {
  await page.locator('[data-testid="row-item"]').nth(n - 1).click()
  await page.locator('[data-testid="detail-panel"] [data-testid^="json-edit-"]').first().waitFor()
  const toggle = page.locator('[data-testid="json-toggle-tags-1"]')
  if (await toggle.count()) {
    await toggle.click()
    await page.waitForTimeout(100)
  }
}

/** Apply the jq filter `.value > 25` (3 of 5 rows match) and wait. */
async function applyJqFilter(page: Page): Promise<void> {
  await page.locator('[data-testid="filter-kind-jq"]').click()
  await page.locator('[data-testid="filter-input"]').fill('.value > 25')
  await page.locator('[data-testid="filter-run"]').click()
  await page.waitForFunction(() => {
    const items = document.querySelectorAll('[data-testid="row-item"]')
    return (
      items.length === 3 &&
      !document.querySelector('[data-testid="filter-progress"]') &&
      !document.querySelector('[data-testid="row-placeholder"]') &&
      document.querySelector('[data-testid="filtered-count"]')?.textContent === '3'
    )
  }, { timeout: 15_000 })
}

/** Edit row 1's `value` to 99 and wait for the edited state. */
async function editValue(page: Page): Promise<void> {
  await page.locator('[data-testid="json-edit-value-1"]').click()
  const input = page.locator('[data-testid="json-edit-input"]')
  await input.waitFor()
  await input.fill('99')
  await input.press('Enter')
  await page.locator('[data-testid="row-edited-badge"]').first().waitFor()
  await page.locator('[data-testid="detail-reset-btn"]').waitFor({ state: 'visible' })
}

async function shotLanding(page: Page, base: string): Promise<void> {
  await page.goto(base)
  await page.locator('button:has-text("Open from URL")').waitFor()
}

async function shotExploring(page: Page, base: string): Promise<void> {
  await loadFixture(page, base)
  await selectRow(page, 3) // charlie — two tags, expanded
}

async function shotUrlModal(page: Page, base: string): Promise<void> {
  await page.goto(base)
  await page.locator('button:has-text("Open from URL")').click()
  // Scope to the dialog containing the URL input (other modals may be
  // teleported but inert).
  const modal = page.locator('[role="dialog"]:has(input[type="url"])')
  await modal.locator('input[type="url"]').fill('https://example.com/data.jsonl')
  // One header row ships with the modal; add a second, then fill the
  // FIRST row only (the second stays a visible empty row).
  await modal.locator('button[aria-label="Add header"]').click()
  await modal
    .locator('input[placeholder="Header name (e.g., Authorization)"]')
    .first()
    .fill('X-Example-Token')
  await modal
    .locator('input[placeholder="Header value"]')
    .first()
    .fill('example-only')
}

async function shotHandover(
  page: Page,
  base: string,
  colorScheme: 'light' | 'dark',
): Promise<Page> {
  // A host on the app origin opens the explorer and deliberately sends NO
  // load, so the explorer stays in its "waiting for data" state. The popup
  // is a NEW page in the same context — it does not inherit the per-page
  // media emulation, so set viewport + theme on it explicitly.
  const host = await page.context().newPage()
  await host.goto(`${base}/e2e-host/host-wait.html`)
  await host.click('button#go')
  const explorer = await page.context().waitForEvent('page')
  await explorer.waitForURL(`${base}/explorer`)
  await explorer.locator('[data-testid="handover-waiting"]').waitFor({ timeout: 15_000 })
  await explorer.setViewportSize(VIEWPORT)
  await explorer.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
  return explorer
}

/** All six shots for one theme. */
async function captureTheme(browser: Browser, colorScheme: 'light' | 'dark', base: string): Promise<void> {
  let page = await shotPage(browser, colorScheme)
  await shotLanding(page, base)
  await capture(page, 'landing', colorScheme)
  await page.close()

  page = await shotPage(browser, colorScheme)
  await shotExploring(page, base)
  await capture(page, 'exploring', colorScheme)

  // Continue the SAME session: filter, capture; clear, edit, capture.
  await applyJqFilter(page)
  await capture(page, 'filtering', colorScheme)

  await page.locator('[data-testid="filter-clear"]').click()
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="row-item"]').length === 5 &&
      !document.querySelector('[data-testid="row-placeholder"]'),
    { timeout: 15_000 },
  )
  await page.locator('[data-testid="row-item"]').first().click()
  await page.locator('[data-testid="detail-panel"] [data-testid^="json-edit-"]').first().waitFor()
  await editValue(page)
  await capture(page, 'editing', colorScheme)
  await page.close()

  page = await shotPage(browser, colorScheme)
  await shotUrlModal(page, base)
  await capture(page, 'url-modal', colorScheme)
  await page.close()

  page = await shotPage(browser, colorScheme)
  const explorer = await shotHandover(page, base, colorScheme)
  await capture(explorer, 'handover', colorScheme)
  await page.context().close()
}

async function main(): Promise<void> {
  ensureBuild()
  const { base, stop } = await startServer()
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      await captureTheme(browser, colorScheme, base)
    }
    console.log(`screenshot: done — ${SHOTS.length * 2} images in public/screenshots`)
  } finally {
    await browser.close()
    stop()
  }
}

void main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
})
