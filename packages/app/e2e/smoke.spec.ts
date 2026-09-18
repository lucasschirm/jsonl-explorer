/**
 * TSK0045 — cross-platform SMOKE subset (chromium always; WebKit when
 * E2E_INCLUDE_WEBKIT=1 in scheduled/manual CI).
 *
 * Kept deliberately small and platform-safe: no File System Access, no
 * clipboard, no download events, no workers-heavy assertions — just
 * "the built app serves and renders on this engine".
 */
import { test, expect } from '@playwright/test'

test.describe('app smoke', () => {
  test('landing page renders with its primary actions', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBe(200)
    await expect(page.locator('h1')).toContainText('JSONL Explorer')
    // The drop zone / open affordance is the landing's core CTA.
    await expect(page.locator('button:has-text("Open")').first()).toBeVisible()
  })

  test('docs index + a guide render content', async ({ page }) => {
    await page.goto('/docs')
    // Nuxt Content (SPA mode) renders the docs index; assert real text.
    await expect(page.locator('main h1')).toHaveText('Documentation')
    // Guide cards link straight to the content _path (/docs/<slug>).
    const card = page.locator('a[href*="/docs/"]').first()
    await expect(card).toBeVisible()
    await card.click()
    await expect(page.locator('article')).toBeVisible()
  })

  test('explorer route renders its empty state (no file, standalone)', async ({ page }) => {
    // Standalone (no opener/parent): the page redirects to the landing with
    // a toast — assert we land somewhere useful, not an error page.
    await page.goto('/explorer')
    await page.waitForURL(/\/(explorer)?$/, { timeout: 30_000 })
    const body = page.locator('body')
    await expect(body).toBeVisible()
    const text = await body.innerText()
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain('Internal server error')
  })
})
