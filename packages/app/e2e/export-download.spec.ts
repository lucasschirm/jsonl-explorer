/**
 * Export download E2E (TSK0036) — real browser, built app:
 *
 * - Blob FALLBACK (no File System Access): a hidden anchor triggers a
 *   real browser download; the downloaded file is compared BYTE-FOR-BYTE
 *   against the fixture (each row ends with exactly one `\n`) and keeps
 *   its `.jsonl` name.
 * - File System Access path (mocked handle): chunks stream into the
 *   writable, `close()` commits and `abort()` is never called, and the
 *   picker received the suggested `.jsonl` name.
 */
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'export-sample.jsonl')

interface FsaResult {
  suggestedName: string | undefined
  bytes: number[]
  closed: boolean
  aborted: boolean
}

async function openFixture(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('#file-input').setInputFiles(FIXTURE)
  // The export button only enables once the file is loaded (canStart).
  await page
    .locator('[data-testid="export-button"]')
    .waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForFunction(
    () => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="export-button"]')
      return button !== null && !button.disabled
    },
    undefined,
    { timeout: 20_000 },
  )
}

test.describe('export download (TSK0036)', () => {
  test('Blob fallback: real download, byte-exact, .jsonl name (FSA removed)', async ({ page }) => {
    // Chromium HAS File System Access: delete it so the app takes the
    // Blob fallback — the exact degradation the support policy requires.
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
    })
    await openFixture(page)

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.locator('[data-testid="export-button"]').click(),
    ])
    expect(download.suggestedFilename()).toBe('export-sample.jsonl')

    const downloaded = await download.path()
    expect(downloaded).toBeTruthy()
    const expected = readFileSync(FIXTURE)
    expect(readFileSync(downloaded!)).toEqual(expected)
  })

  test('File System Access: streams exact bytes into the writable, commits with close()', async ({ page }) => {
    // Mock the picker (a real native dialog is not automatable): capture
    // every chunk written through the app's FSA pipeline.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __fsaChunks?: Uint8Array[]
        __fsaOpts?: { suggestedName?: string }
        __fsaClosed?: boolean
        __fsaAborted?: boolean
        showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<unknown>
      }
      w.__fsaChunks = []
      w.showSaveFilePicker = async (opts) => {
        w.__fsaOpts = opts
        return {
          createWritable: async () => ({
            write: async (data: Uint8Array) => {
              w.__fsaChunks?.push(new Uint8Array(data))
            },
            close: async () => {
              w.__fsaClosed = true
            },
            abort: async () => {
              w.__fsaAborted = true
            },
          }),
        }
      }
    })
    await openFixture(page)

    await page.locator('[data-testid="export-button"]').click()
    // Success = close() (commit). The run finishes: the status strip is gone.
    await page.waitForFunction(() => (window as unknown as { __fsaClosed?: boolean }).__fsaClosed === true, undefined, {
      timeout: 30_000,
    })

    const result: FsaResult = await page.evaluate(() => {
      const w = window as unknown as {
        __fsaChunks: Uint8Array[]
        __fsaOpts?: { suggestedName?: string }
        __fsaClosed?: boolean
        __fsaAborted?: boolean
      }
      const bytes: number[] = []
      for (const chunk of w.__fsaChunks) {
        for (const b of chunk) bytes.push(b)
      }
      return {
        suggestedName: w.__fsaOpts?.suggestedName,
        bytes,
        closed: w.__fsaClosed === true,
        aborted: w.__fsaAborted === true,
      }
    })

    expect(result.suggestedName).toBe('export-sample.jsonl')
    expect(result.aborted).toBe(false)
    expect(Buffer.from(result.bytes)).toEqual(readFileSync(FIXTURE))
  })
})
