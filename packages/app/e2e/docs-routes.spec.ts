/**
 * TSK0048 — docs routing E2E (real browser, built app).
 *
 * The static-host model is the SPA + nitro fallback, so "every guide
 * direct URL works" means: a COLD navigation to /docs/<slug> (no
 * client-side history) serves the app and renders the guide. This suite
 * discovers the guides from the rendered index (no hardcoded slugs) and
 * deep-links each one in a fresh page, plus checks prev/next navigation
 * and the not-found state.
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = 'http://localhost:4173'

/** Collect {path, title} for every guide card on the index. */
async function indexGuides(page: Page): Promise<{ path: string; title: string }[]> {
  await page.goto(`${BASE}/docs`)
  const cards = page.locator('main a[href^="/docs/"]')
  await expect(cards.first()).toBeVisible({ timeout: 15_000 })
  const n = await cards.count()
  const guides: { path: string; title: string }[] = []
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i)
    guides.push({
      path: (await card.getAttribute('href')) ?? '',
      title: ((await card.locator('h3').textContent()) ?? '').trim(),
    })
  }
  return guides
}

test.describe('docs routes (TSK0048)', () => {
  test('index lists every guide with a title and description', async ({ page }) => {
    const guides = await indexGuides(page)
    expect(guides.length).toBeGreaterThanOrEqual(6)
    for (const g of guides) {
      expect(g.path).toMatch(/^\/docs\/[a-z0-9-]+$/)
      expect(g.title.length).toBeGreaterThan(0)
    }
    // Descriptions come from the typed frontmatter.
    await expect(page.locator('main .card-body p').first()).not.toHaveText('')
  })

  test('every guide direct URL renders from a cold navigation (deep link)', async ({ browser }) => {
    const finder = await browser.newPage()
    const guides = await indexGuides(finder)
    await finder.close()

    for (const g of guides) {
      // A FRESH page per guide: no client-side history, exactly what a
      // user hitting the direct URL (or a shared link) gets.
      const page = await browser.newPage()
      await page.goto(`${BASE}${g.path}`)
      await expect(page.locator('main h1')).toHaveText(g.title, { timeout: 15_000 })
      await page.close()
    }
  })

  test('prev/next navigation walks the guides in display order', async ({ page }) => {
    const guides = await indexGuides(page)
    const first = guides[0]!
    const second = guides[1]!
    const last = guides[guides.length - 1]!

    // From the FIRST guide: no previous, next is the second.
    await page.goto(`${BASE}${first.path}`)
    await expect(page.locator('main h1')).toHaveText(first.title)
    const nav = page.locator('nav[aria-label="Guide navigation"]')
    await expect(nav).toBeVisible()
    await expect(nav).not.toContainText('←')
    await expect(nav).toContainText(second.title)

    // From the LAST guide: previous is the second-to-last, no next.
    await page.goto(`${BASE}${last.path}`)
    await expect(page.locator('main h1')).toHaveText(last.title)
    await expect(nav).toContainText(guides[guides.length - 2]!.title)
    await expect(nav).not.toContainText('→')
  })

  test('unknown slug shows the not-found state with a way back', async ({ page }) => {
    await page.goto(`${BASE}/docs/definitely-not-a-guide`)
    await expect(page.locator('main')).toContainText('Guide not found')
    await expect(page.locator('main a[href="/docs"]')).toBeVisible()
  })

  test('docs stay usable at a narrow viewport (no horizontal overflow)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const guides = await indexGuides(page)
    const first = guides[0]!
    await page.goto(`${BASE}${first.path}`)
    await expect(page.locator('main h1')).toHaveText(first.title)
    // The document must fit the viewport width: long code lines scroll
    // inside their block (daisyUI prose `pre`), never the page itself.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    // And it renders under the dark theme too (daisyUI themes both adapt
    // via the data-theme attribute the app manages).
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('main h1')).toBeVisible()
  })
})
