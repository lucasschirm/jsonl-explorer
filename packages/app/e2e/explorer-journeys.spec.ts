/**
 * TSK0046 — landing + explorer WORKFLOW E2E (real browser, built app).
 *
 * Picker/drop → rows/counts/selection/detail; virtualized DOM stays
 * bounded during deep scrolling; text + jq filters; invalid JSON is
 * visible (never silent); Raw view; click-to-edit + reset; filtered
 * export is byte-exact; theme follows the system preference live.
 *
 * Fixtures are small and deterministic (PR speed); the 20k-row file is
 * generated in memory here (not committed).
 */
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const JOURNEYS = join(here, 'fixtures', 'journeys.jsonl')
const INVALID = join(here, 'fixtures', 'invalid.jsonl')

/** Generate N JSONL rows in memory (deterministic, ~40 B/row). */
function bigFile(n: number): { name: string; mimeType: string; buffer: Buffer } {
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(`{"i":${i},"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}`)
  return { name: 'big.jsonl', mimeType: 'application/jsonl', buffer: Buffer.from(parts.join('\n') + '\n') }
}

async function pickFile(page: Page, files: Parameters<Page['setInputFiles']>['1']): Promise<void> {
  await page.goto('/')
  await page.locator('#file-input').setInputFiles(files)
  // The row list is mounted as soon as the source exists.
  await page.locator('[data-testid="row-list-scroll"]').waitFor({ state: 'visible', timeout: 30_000 })
}

async function expectCounts(page: Page, total: string, filtered: string): Promise<void> {
  await expect(page.locator('[data-testid="total-count"]')).toHaveText(total, { timeout: 30_000 })
  await expect(page.locator('[data-testid="filtered-count"]')).toHaveText(filtered)
}

test.describe('explorer journeys (TSK0046)', () => {
  test('picker load: rows, counts, first-row preselection, click selection + detail', async ({ page }) => {
    await pickFile(page, JOURNEYS)
    await expectCounts(page, '5', '5')
    await expect(page.locator('[data-testid="row-item"]')).toHaveCount(5)

    // First row is preselected: its list item carries the selection class
    // and the detail panel shows its content.
    const first = page.locator('[data-testid="row-item"]').first()
    await expect(first).toHaveClass(/bg-primary/)
    await expect(page.locator('[data-testid="detail-panel"]')).toBeVisible()
    await expect(page.locator('[data-testid="detail-panel"]')).toContainText('alpha')

    // Clicking row 3 selects it and updates the detail.
    await page.locator('[data-testid="row-item"]').nth(2).click()
    await expect(page.locator('[data-testid="row-item"]').nth(2)).toHaveClass(/bg-primary/)
    await expect(page.locator('[data-testid="detail-panel"]')).toContainText('charlie')
  })

  test('virtualized rows stay bounded while deep-scrolling a 20k-row file', async ({ page }) => {
    await pickFile(page, bigFile(20_000))
    await expectCounts(page, '20,000', '20,000')

    // Bounded window at the top.
    let items = page.locator('[data-testid="row-item"]')
    expect(await items.count()).toBeGreaterThan(0)
    expect(await items.count()).toBeLessThanOrEqual(64)

    // Deep scroll: the viewport moves, the DOM window stays bounded, and
    // the last row's content is reachable.
    await page.locator('[data-testid="row-list-scroll"]').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(500) // let the window settle
    const count = await items.count()
    expect(count).toBeLessThanOrEqual(64)
    await expect(items.last()).toContainText('"i":19999')
    await expect(page.locator('[data-testid="total-count"]')).toHaveText('20,000')
  })

  test('text filter: run on Enter, clear restores', async ({ page }) => {
    await pickFile(page, JOURNEYS)
    await expectCounts(page, '5', '5')

    const input = page.locator('[data-testid="filter-input"]')
    await input.fill('charlie')
    await input.press('Enter')
    await expectCounts(page, '5', '1')
    await expect(page.locator('[data-testid="row-item"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="row-item"]').first()).toContainText('charlie')

    await page.locator('[data-testid="filter-clear"]').click()
    await expectCounts(page, '5', '5')
  })

  test('jq filter: kind toggle, run, clear', async ({ page }) => {
    await pickFile(page, JOURNEYS)
    await expectCounts(page, '5', '5')

    await page.locator('[data-testid="filter-kind-jq"]').click()
    const input = page.locator('[data-testid="filter-input"]')
    await input.fill('.i == 2')
    await page.locator('[data-testid="filter-run"]').click()
    await expectCounts(page, '5', '1')
    await expect(page.locator('[data-testid="row-item"]').first()).toContainText('charlie')

    await page.locator('[data-testid="filter-clear"]').click()
    await expectCounts(page, '5', '5')
  })

  test('invalid JSON line: visible banner, counted in totals, no silent failure', async ({ page }) => {
    await pickFile(page, INVALID)
    // All three lines are rows; the bad one is flagged in the detail, not hidden.
    await expectCounts(page, '3', '3')
    await page.locator('[data-testid="row-item"]').nth(1).click()
    const banner = page.locator('[data-testid="detail-invalid-banner"]')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Not valid JSON')
  })

  test('Raw view: virtualized modal shows current rows, closes on Escape', async ({ page }) => {
    await pickFile(page, JOURNEYS)
    await expectCounts(page, '5', '5')

    await page.locator('[data-testid="detail-raw-btn"]').click()
    const modal = page.locator('[data-testid="raw-modal-body"]')
    await expect(modal).toBeVisible()

    const items = page.locator('[data-testid="raw-item"]')
    expect(await items.count()).toBeGreaterThan(0)
    expect(await items.count()).toBeLessThanOrEqual(64) // virtualized, never all rows
    await expect(items.first()).toContainText('"name":"alpha"')
    await expect(page.locator('[data-testid="raw-footer"]')).toContainText('5 rows')

    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })

  test('click-to-edit: row badge + preview update, filter sees the edit, reset restores', async ({
    page,
  }) => {
    await pickFile(page, JOURNEYS)
    await expectCounts(page, '5', '5')

    // Row 1 is preselected (alpha). Click its `name` value token.
    await page.locator('[data-testid^="json-edit-name-"]').first().click()
    const edit = page.locator('[data-testid="json-edit-input"]')
    await expect(edit).toBeVisible()
    await edit.fill('"edited-name"')
    await edit.press('Enter')

    // The row shows the edited preview + badge.
    const first = page.locator('[data-testid="row-item"]').first()
    await expect(first).toContainText('edited-name')
    await expect(page.locator('[data-testid="row-edited-badge"]').first()).toBeVisible()

    // Filters run against edited content.
    const input = page.locator('[data-testid="filter-input"]')
    await input.fill('edited-name')
    await input.press('Enter')
    await expectCounts(page, '5', '1')
    await page.locator('[data-testid="filter-clear"]').click()
    await expectCounts(page, '5', '5')

    // Reset the line: badge gone, original content back.
    await page.locator('[data-testid="detail-reset-btn"]').click()
    await expect(page.locator('[data-testid="row-item"]').first()).toContainText('alpha')
    expect(await page.locator('[data-testid="row-edited-badge"]').count()).toBe(0)
  })

  test('filtered export is byte-exact (Blob fallback)', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
    })
    await pickFile(page, JOURNEYS)
    await expectCounts(page, '5', '5')

    const input = page.locator('[data-testid="filter-input"]')
    await input.fill('charlie')
    await input.press('Enter')
    await expectCounts(page, '5', '1')

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.locator('[data-testid="export-button"]').click(),
    ])
    expect(download.suggestedFilename()).toBe('journeys.jsonl')
    const downloaded = await download.path()
    expect(downloaded).toBeTruthy()
    // Exactly the one matching source line, byte-for-byte.
    expect(readFileSync(downloaded!)).toEqual(
      Buffer.from('{"i":2,"name":"charlie","tags":["c","d"],"value":30}\n'),
    )
  })

  test('theme follows system preference and changes live', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  })
})
