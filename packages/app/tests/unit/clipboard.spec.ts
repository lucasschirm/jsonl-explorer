/**
 * Clipboard helper (TSK0025): async Clipboard API preferred, execCommand
 * fallback, and failures that REJECT (callers surface them — copying
 * never fails silently).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { copyText } from '~/utils/clipboard'

function withClipboard(impl: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value: impl, configurable: true })
}

afterEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    withClipboard({ writeText })
    await copyText('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('propagates a clipboard denial as a rejection', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard access denied'))
    withClipboard({ writeText })
    await expect(copyText('x')).rejects.toThrow('Clipboard access denied')
  })

  it('falls back to execCommand when the API is absent', () => {
    withClipboard(undefined)
    // happy-dom has no execCommand: define it (the fallback path uses it).
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(true),
      configurable: true,
    })
    return expect(copyText('fallback')).resolves.toBeUndefined()
  })

  it('rejects when the fallback is blocked', () => {
    withClipboard(undefined)
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    })
    return expect(copyText('nope')).rejects.toThrow(/blocked clipboard access/)
  })
})
