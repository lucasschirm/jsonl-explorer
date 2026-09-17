/**
 * TSK0039 — handover/bootstrap SECURITY harnesses in a real browser.
 *
 * - window.open host (same origin): ready→load→loaded round trip,
 *   duplicate load ignored, disposal ("Upload another file") blocks
 *   later loads.
 * - Hostile page on an UNALLOWED origin: cannot trigger a load and
 *   receives no replies at all.
 * - Sandboxed iframe host (documented configuration): handover works.
 * - `?url=` bootstrap: query scrubbed from the address bar, the worker's
 *   fetch carries NO Referer (no-referrer policy), the policy is present
 *   in headers/meta, and the signed token never appears in console output.
 *
 * Same-origin hosts + the bootstrap data file are served by the e2e
 * front server under `/e2e-host/*` (e2e/fixtures); the hostile host is
 * served by a throwaway fixture server on 127.0.0.1 (a genuinely
 * different origin, so its messages fail the explorer's origin check).
 */
import { test, expect, type Page } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const EXPLORER_ORIGIN = 'http://localhost:4173'
const TOKEN = 'secret-token-xyz'

let hostileServer: http.Server
let hostilePort = 0

test.beforeAll(async () => {
  hostileServer = http.createServer((req, res) => {
    const headers: Record<string, string> = { 'access-control-allow-origin': '*' }
    if (req.url?.startsWith('/hostile')) {
      res.writeHead(200, { ...headers, 'content-type': 'text/html' })
      res.end(readFileSync(join(here, 'fixtures', 'hostile.html')))
      return
    }
    res.writeHead(404, headers)
    res.end()
  })
  await new Promise<void>((resolve) => hostileServer.listen(0, '127.0.0.1', () => resolve()))
  hostilePort = (hostileServer.address() as AddressInfo).port
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => hostileServer.close(() => resolve()))
})

async function loadedCount(host: Page): Promise<number> {
  return host.evaluate(() => {
    const log = JSON.parse(document.getElementById('log')?.textContent ?? '[]')
    return log.filter((m: { type: string }) => m.type === 'loaded').length
  })
}

test('window.open host: ready→load→loaded; duplicate ignored; disposal blocks later loads', async ({
  context,
}) => {
  test.setTimeout(90_000)
  const host = await context.newPage()
  await host.goto(`${EXPLORER_ORIGIN}/e2e-host/host-window.html`)
  const [popup] = await Promise.all([context.waitForEvent('page'), host.click('#go')])

  // The 2-row host payload lands (ready → load → index → rows).
  await popup.waitForSelector('[data-testid="row-item"]', { timeout: 60_000 })
  await expect(popup.locator('[data-testid="row-item"]')).toHaveCount(2)
  await host.waitForFunction(() => {
    const log = JSON.parse(document.getElementById('log')?.textContent ?? '[]')
    return log.some((m: { type: string; lines?: number }) => m.type === 'loaded' && m.lines === 2)
  }, undefined, { timeout: 30_000 })

  // Duplicate load (different payload/name): ignored — rows stay, no new
  // reply (silence is the contract: a retry must not read as a failure).
  await host.evaluate(() => {
    const w = window as unknown as { sendLoad: (p: string, n: string) => void }
    w.sendLoad('{"d":1}\n{"d":2}\n{"d":3}\n', 'dup.jsonl')
  })
  await host.waitForTimeout(2_500)
  await expect(popup.locator('[data-testid="row-item"]')).toHaveCount(2)
  expect(await loadedCount(host)).toBe(1)

  // "Upload another file" disposes the session; a later load is ignored.
  await popup.click('[data-testid="upload-another"]')
  await popup.waitForURL(`${EXPLORER_ORIGIN}/`)
  await host.evaluate(() => {
    const w = window as unknown as { sendLoad: (p: string, n: string) => void }
    w.sendLoad('{"late":1}\n', 'late.jsonl')
  })
  await host.waitForTimeout(2_500)
  expect(await loadedCount(host)).toBe(1)
  await expect(popup.locator('[data-testid="row-item"]')).toHaveCount(0)
})

test('hostile page on an unallowed origin: no load, no replies', async ({ context, page }) => {
  test.setTimeout(90_000)
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.goto(`http://127.0.0.1:${hostilePort}/hostile`),
  ])

  // All three attempts are made (2 s / 4.5 s / 7 s), then a settle window.
  await page.waitForFunction(
    () => (window as unknown as { __hostile: { sent: number } }).__hostile.sent === 3,
    undefined,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(1_500)

  // Total silence: no ready, no loaded, no error reached this origin.
  const state = await page.evaluate(
    () => (window as unknown as { __hostile: { got: string[]; sent: number } }).__hostile,
  )
  expect(state.sent).toBe(3)
  expect(state.got).toEqual([])

  // The explorer never loaded the hostile payload: still the empty state.
  await expect(popup.locator('[data-testid="row-item"]')).toHaveCount(0)
  await expect(popup.locator('#file-input')).toHaveCount(1)
  expect(popup.url()).not.toContain('evil')
})

test('sandboxed iframe host (allow-same-origin): handover works', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto(`${EXPLORER_ORIGIN}/e2e-host/host-iframe.html`)
  await page.waitForFunction(
    () => {
      const log = JSON.parse(document.getElementById('log')?.textContent ?? '[]')
      return log.some((m: { type: string; lines?: number }) => m.type === 'loaded' && m.lines === 3)
    },
    undefined,
    { timeout: 60_000 },
  )
  // Playwright CSS does not cross frame boundaries: use frameLocator.
  await expect(page.frameLocator('#exp').locator('[data-testid="row-item"]')).toHaveCount(3)
})

test('?url= bootstrap: scrubbed, no referrer, no token in logs', async ({ page, request }) => {
  test.setTimeout(90_000)
  const consoleTexts: string[] = []
  page.on('console', (msg) => consoleTexts.push(msg.text()))

  // Same-origin data (connect-src 'self'), with a signed token in the
  // query: if the referrer policy or scrubbing failed, this token would
  // leak into the data server's logs via the Referer header.
  const dataUrl = `${EXPLORER_ORIGIN}/e2e-host/data.jsonl?token=${TOKEN}`
  const target = `${EXPLORER_ORIGIN}/explorer?url=${encodeURIComponent(dataUrl)}`
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().startsWith(`${EXPLORER_ORIGIN}/explorer`),
      { timeout: 30_000 },
    ),
    page.goto(target),
  ])

  // The 2-row fixture lands through the real worker fetch path.
  await page.waitForSelector('[data-testid="row-item"]', { timeout: 60_000 })
  await expect(page.locator('[data-testid="row-item"]')).toHaveCount(2)

  // Scrubbed: the signed query is gone from the address bar.
  expect(page.url()).toBe(`${EXPLORER_ORIGIN}/explorer`)

  // No-referrer policy on the served document (header AND meta).
  expect(response.headers()['referrer-policy']).toBe('no-referrer')
  const html = await response.text()
  expect(html).toContain('name="referrer" content="no-referrer"')

  // The worker's fetch carried NO Referer: the signed URL (and any
  // capability in it) never reached the data server via referrer.
  const seenResp = await request.get(`${EXPLORER_ORIGIN}/e2e-host/__seen`)
  const seen: Array<{ path: string; referer: string | null }> = await seenResp.json()
  const dataReqs = seen.filter((s) => s.path.startsWith('/e2e-host/data.jsonl'))
  expect(dataReqs.length).toBeGreaterThanOrEqual(1)
  for (const req of dataReqs) {
    expect(req.referer).toBeNull()
  }

  // Settle, then assert the token never surfaced in console output.
  await page.waitForTimeout(1_000)
  for (const text of consoleTexts) {
    expect(text).not.toContain(TOKEN)
  }
})
