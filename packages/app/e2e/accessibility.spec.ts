/**
 * TSK0052 — automated accessibility checks (axe-core, real browser, built
 * app).
 *
 * Critical flows in BOTH daisyUI themes: landing, explorer (loaded file,
 * row selected), filtering, editing, raw modal, about, docs. Policy: ZERO
 * violations — every one is reported with its axe rule id so fixes stay
 * actionable. (Tags: WCAG 2.0/2.1 A+AA plus best-practice.)
 */
import AxeBuilder from '@axe-core/playwright'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'journeys.jsonl')

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze()
  if (results.violations.length === 0) return
  const lines = results.violations.map((v) => {
    const targets = v.nodes
      .map((n) => String(Array.isArray(n.target) ? n.target.join(' > ') : n.target))
      .join(' | ')
    return `  [${v.impact ?? 'n/a'}] ${v.id} — ${v.help}\n      ${targets.slice(0, 200)}`
  })
  throw new Error(`axe violations (${results.violations.length}):\n${lines.join('\n')}`)
}

/** Load the fixture through the drop zone and wait for the settled list. */
async function loadFixture(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'journeys.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: readFileSync(FIXTURE),
  })
  await page.waitForURL(/\/explorer/)
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="total-count"]')?.textContent === '5' &&
      !document.querySelector('[data-testid="partial-marker"]') &&
      !document.querySelector('[data-testid="row-placeholder"]'),
    { timeout: 15_000 },
  )
}

test.describe('focus management (TSK0052)', () => {
  test('modal close returns focus to the trigger', async ({ page }) => {
    await page.goto('/')
    const trigger = page.locator('button:has-text("Open from URL")')
    await trigger.focus()
    // Keyboard-only open:
    await page.keyboard.press('Enter')
    const dialog = page.locator('[role="dialog"]:has(input[type="url"])')
    await dialog.waitFor()
    // Focus moved into the modal (initial focus):
    const focusInDialog = await page.evaluate(() =>
      document.activeElement?.closest('[role="dialog"]') !== null,
    )
    expect(focusInDialog).toBe(true)
    // Keyboard-only close (Escape) → focus returns to the trigger:
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    const focusText = await page.evaluate(() => document.activeElement?.textContent ?? '')
    expect(focusText).toContain('Open from URL')
  })
})

test.describe('keyboard-only flows (TSK0052)', () => {
  /** Read an attribute of the currently focused element (Playwright has
   *  no `:focus` selector — ask the page directly). */
  const focusedAttr = (page: Page, attr: string): Promise<string | null> =>
    page.evaluate(
      (a) => (document.activeElement as HTMLElement | null)?.getAttribute(a) ?? null,
      attr,
    )

  test('landing → load file → select row → edit value', async ({ page }) => {
    // No mouse: everything via keyboard. Enter on the drop zone opens the
    // native file chooser (filechooser event), which we answer with the
    // fixture — the same path a keyboard user drives the OS dialog on.
    await page.goto('/')
    // Wait for the SPA to render (goto resolves at 'load', before Vue
    // mounts the landing page):
    await page.locator('[role="button"][aria-label^="File drop zone"]').waitFor()
    const fileChooserPromise = page.waitForEvent('filechooser')
    // Tab to the drop zone (the first focusable control on the landing
    // page) and open the native file chooser with Enter:
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab')
      const label = await focusedAttr(page, 'aria-label')
      if (label !== null && label.startsWith('File drop zone')) break
    }
    expect(await focusedAttr(page, 'aria-label')).toMatch(/^File drop zone/)
    const [fileChooser] = await Promise.all([fileChooserPromise, page.keyboard.press('Enter')])
    await fileChooser.setFiles(FIXTURE)
    await page.waitForURL(/\/explorer/)
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="total-count"]')?.textContent === '5' &&
        !document.querySelector('[data-testid="row-placeholder"]'),
      { timeout: 15_000 },
    )
    // Tab to the first row and activate it (rows are real buttons):
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      if ((await focusedAttr(page, 'data-testid')) === 'row-item') break
    }
    expect(await focusedAttr(page, 'data-testid')).toBe('row-item')
    await page.keyboard.press('Enter')
    await page
      .locator('[data-testid="detail-panel"] [data-testid^="json-edit-"]')
      .first()
      .waitFor()
    // Keyboard into the value editor: Tab until a tree edit button is
    // focused (tree controls are real, focusable buttons), Enter starts
    // the inline edit (the input auto-focuses), type, commit with Enter.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab')
      const focused = await focusedAttr(page, 'data-testid')
      if (focused !== null && focused.startsWith('json-edit-')) {
        await page.keyboard.press('Enter')
        break
      }
    }
    expect(await focusedAttr(page, 'data-testid')).toBe('json-edit-input')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('42')
    await page.keyboard.press('Enter')
    await page.locator('[data-testid="row-edited-badge"]').first().waitFor()
  })
})

test.describe('reduced motion (TSK0052)', () => {
  test.use({ reducedMotion: 'reduce' })

  test('app CSS honors prefers-reduced-motion', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(() => {
      const el = document.createElement('div')
      el.className = 'animate-pulse'
      document.body.appendChild(el)
      const cs = getComputedStyle(el)
      const html = getComputedStyle(document.documentElement)
      // Read BEFORE removing: a computed-style object is live and goes
      // stale (empty) once the element leaves the document.
      const animationDuration = cs.animationDuration
      const scrollBehavior = html.scrollBehavior
      el.remove()
      return {
        media: matchMedia('(prefers-reduced-motion: reduce)').matches,
        animationDuration,
        scrollBehavior,
      }
    })
    expect(result.media).toBe(true)
    // 0.01ms serialized by Chromium as 1e-05s — parse, don't string-match.
    expect(parseFloat(result.animationDuration)).toBeLessThanOrEqual(0.01)
    expect(result.scrollBehavior).toBe('auto')
  })

})

test.describe('accessibility (TSK0052)', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`theme=${colorScheme}`, () => {
      test.use({ colorScheme })

      test('landing', async ({ page }) => {
        await page.goto('/')
        await expectAccessible(page)
      })

      test('explorer with file loaded and a row selected', async ({ page }) => {
        await loadFixture(page)
        await page.locator('[data-testid="row-item"]').nth(1).click()
        await page
          .locator('[data-testid="detail-panel"] [data-testid^="json-edit-"]')
          .first()
          .waitFor()
        await expectAccessible(page)
      })

      test('filter applied (jq)', async ({ page }) => {
        await loadFixture(page)
        await page.locator('[data-testid="filter-kind-jq"]').click()
        await page.locator('[data-testid="filter-input"]').fill('.value > 25')
        await page.locator('[data-testid="filter-run"]').click()
        await page.waitForFunction(
          () =>
            document.querySelectorAll('[data-testid="row-item"]').length === 3 &&
            !document.querySelector('[data-testid="filter-progress"]'),
          { timeout: 15_000 },
        )
        await expectAccessible(page)
      })

      test('row edited (badges + reset)', async ({ page }) => {
        await loadFixture(page)
        await page.locator('[data-testid="row-item"]').first().click()
        await page.locator('[data-testid="json-edit-value-1"]').click()
        const input = page.locator('[data-testid="json-edit-input"]')
        await input.waitFor()
        await input.fill('99')
        await input.press('Enter')
        await page.locator('[data-testid="row-edited-badge"]').first().waitFor()
        await expectAccessible(page)
      })

      test('raw modal open', async ({ page }) => {
        await loadFixture(page)
        await page.locator('[data-testid="row-item"]').first().click()
        await page.locator('[data-testid="detail-raw-btn"]').click()
        await page.locator('[role="dialog"]').last().waitFor()
        await expectAccessible(page)
      })

      test('open-from-url modal open', async ({ page }) => {
        await page.goto('/')
        await page.locator('button:has-text("Open from URL")').click()
        await page.locator('[role="dialog"]:has(input[type="url"])').waitFor()
        await expectAccessible(page)
      })

      test('about page', async ({ page }) => {
        await page.goto('/about')
        await expectAccessible(page)
      })

      test('docs index + a guide', async ({ page }) => {
        await page.goto('/docs')
        await expectAccessible(page)
        await page.goto('/docs/exploring-data')
        await expect(page.locator('main h1')).toHaveText('Exploring Data')
        await expectAccessible(page)
      })
    })
  }
})
