/**
 * TSK0015 — worker-owned streaming URL source: validation, sanitization,
 * typed failure classification, and the scanner's incremental feed API.
 *
 * Covers:
 * - `JsonlScanner.feed`/`finish` (rows queryable between feeds)
 * - `engine/url.ts` (http/https validation, header sanitization, URL redaction)
 * - `UrlDownloader` URL rules (typed errors, sanitized headers on the wire,
 *   redirect handling, missing body, onSpoolCreated, async onProgress)
 *
 * Worker-level streaming behavior (rows visible mid-download, indexComplete)
 * lives in `spool.spec.ts`, which owns the postMessage harness.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

import { JsonlScanner, IndexAbortedError } from '../../engine/scanner.js'
import { MemorySource } from '../../engine/sources/index.js'
import {
  UrlCorsDeniedError,
  UrlDownloader,
  UrlFetchError,
  UrlInvalidHeadersError,
  UrlRedirectDeniedError,
  UrlValidationError,
  isCrossOrigin,
  redactUrl,
  sanitizeHeaders,
  validateHttpUrl,
} from '../../engine/spool/index.js'
import { encode, makeFetch } from '../helpers/spoolFakes.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

// ============================================================================
// JsonlScanner incremental feed
// ============================================================================

describe('JsonlScanner incremental feed', () => {
  const DATA = '[{"id":1}]\n\n[{"id":2}]\r\n[{"id":3}'

  it('matches a full scan when fed in small chunks (rows, offsets, CRLF, UTF-8)', async () => {
    const reference = new MemorySource('ref', DATA)
    const refScanner = new JsonlScanner(reference)
    const refResult = await refScanner.scan()

    const fed = new MemorySource('fed', DATA)
    const fedScanner = new JsonlScanner(fed, { chunkSize: 7 })
    const bytes = encode(DATA)
    for (let i = 0; i < bytes.length; i += 7) {
      fedScanner.feed(bytes.slice(i, i + 7), BigInt(i))
    }
    const fedResult = fedScanner.finish(BigInt(bytes.length))

    expect(fedResult.totalRows).toBe(refResult.totalRows)
    expect(fedResult.totalRows).toBe(4) // incl. the internal blank line
    expect(fedResult.hasCRLF).toBe(true)
    expect(fedResult.invalidUtf8Rows).toBe(0)
    for (let row = 0; row < refResult.totalRows; row++) {
      expect(fedScanner.getStart(row)).toBe(refScanner.getStart(row))
      expect(fedScanner.getDisplayEnd(row)).toBe(refScanner.getDisplayEnd(row))
    }
  })

  it('commits rows between feeds (queryable while the source grows)', () => {
    const source = new MemorySource('grow', '')
    const scanner = new JsonlScanner(source, { chunkSize: 4 })
    scanner.feed(encode('ab\n'), 0n)
    expect(scanner.getRowCount()).toBe(1)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(2n)
    scanner.feed(encode('cd\nef'), 3n)
    expect(scanner.getRowCount()).toBe(2) // 'ef' is still open
    const result = scanner.finish(9n)
    expect(result.totalRows).toBe(3)
  })

  it('handles a CRLF split across feed boundaries', () => {
    const source = new MemorySource('crlf', '')
    const scanner = new JsonlScanner(source)
    scanner.feed(encode('row\r'), 0n) // CR at chunk end
    scanner.feed(encode('\n'), 4n) // LF in the next feed
    const result = scanner.finish(5n)
    expect(result.totalRows).toBe(1)
    expect(result.hasCRLF).toBe(true)
    expect(scanner.getDisplayEnd(0)).toBe(3n) // CR + LF stripped
  })

  it('commits a final row without a terminating LF on finish', () => {
    const scanner = new JsonlScanner(new MemorySource('t', ''))
    scanner.feed(encode('one\ntwo'), 0n)
    const result = scanner.finish(7n)
    expect(result.totalRows).toBe(2)
    expect(scanner.getStart(1)).toBe(4n)
    expect(scanner.getDisplayEnd(1)).toBe(7n)
  })

  it('finishes an empty feed as a zero-row document', () => {
    const scanner = new JsonlScanner(new MemorySource('empty', ''))
    scanner.feed(new Uint8Array(0), 0n)
    const result = scanner.finish(0n)
    expect(result.totalRows).toBe(0)
    expect(result.totalBytes).toBe(0n)
  })

  it('rejects feed after finish, mixed scan/feed modes, and unstarted finish', async () => {
    const scanner = new JsonlScanner(new MemorySource('t', ''))
    scanner.feed(encode('a\n'), 0n)
    scanner.finish(2n)
    expect(() => scanner.feed(encode('b\n'), 2n)).toThrow(/completed/)
    expect(() => scanner.finish(2n)).toThrow(/completed/)
    await expect(scanner.scan()).rejects.toThrow(/already used/)

    const fedFirst = new JsonlScanner(new MemorySource('t2', ''))
    fedFirst.feed(encode('a\n'), 0n)
    await expect(fedFirst.scan()).rejects.toThrow(/mix scan\(\) and feed\(\)/)

    // drivenBy is set synchronously by scan(); call feed() before the scan
    // can progress past its first await.
    const scanFirst = new JsonlScanner(new MemorySource('t3', 'a\n'))
    void scanFirst.scan().catch(() => {})
    expect(() => scanFirst.feed(encode('x'), 0n)).toThrow(/mix scan\(\) and feed\(\)/)

    const untouched = new JsonlScanner(new MemorySource('t4', ''))
    expect(() => untouched.finish(0n)).toThrow(/not started/)
  })

  it('exposes the chunk size for feed step sizing', () => {
    expect(new JsonlScanner(new MemorySource('t', '')).chunkSize).toBe(64 * 1024)
    expect(new JsonlScanner(new MemorySource('t', ''), { chunkSize: 123 }).chunkSize).toBe(123)
  })

  it('still throws IndexAbortedError from scan() aborts (unchanged behavior)', async () => {
    const source = new MemorySource('big', 'x'.repeat(200) + '\n')
    const scanner = new JsonlScanner(source, { chunkSize: 8 })
    const controller = new AbortController()
    controller.abort()
    await expect(scanner.scan({ signal: controller.signal })).rejects.toBeInstanceOf(IndexAbortedError)
  })
})

// ============================================================================
// engine/url.ts — validation and sanitization
// ============================================================================

describe('url.ts', () => {
  it('validateHttpUrl accepts http/https and rejects other schemes and garbage', () => {
    expect(validateHttpUrl('https://example.com/a.jsonl').protocol).toBe('https:')
    expect(validateHttpUrl('http://example.com').protocol).toBe('http:')
    expect(() => validateHttpUrl('ftp://example.com/a.jsonl')).toThrow(UrlValidationError)
    expect(() => validateHttpUrl('file:///etc/passwd')).toThrow(UrlValidationError)
    expect(() => validateHttpUrl('javascript:alert(1)')).toThrow(UrlValidationError)
    expect(() => validateHttpUrl('not a url')).toThrow(UrlValidationError)
    expect(new UrlValidationError('x').code).toBe('URL_INVALID')
  })

  it('sanitizeHeaders drops forbidden names and empty values, keeps the rest', () => {
    const out = sanitizeHeaders({
      'X-Custom': 'kept',
      Authorization: 'Bearer tok',
      Host: 'evil',
      'Content-Length': '999',
      'Accept-Encoding': 'gzip',
      Connection: 'close',
      'X-Empty': '',
    })
    expect(out).toEqual({ 'X-Custom': 'kept', Authorization: 'Bearer tok' })
    expect(sanitizeHeaders(undefined)).toEqual({})
  })

  it('sanitizeHeaders rejects invalid header names with a typed error', () => {
    expect(() => sanitizeHeaders({ 'Bad Header': 'x' })).toThrow(UrlInvalidHeadersError)
    expect(() => sanitizeHeaders({ 'Bad\u0000Name': 'x' })).toThrow(/not a valid header name/)
    expect(new UrlInvalidHeadersError('x').code).toBe('URL_INVALID_HEADERS')
  })

  it('redactUrl strips userinfo but leaves ordinary URLs untouched', () => {
    expect(redactUrl('https://user:pass@example.com/a.jsonl')).toBe('https://example.com/a.jsonl')
    expect(redactUrl('https://user@example.com/a.jsonl?x=1')).toBe('https://example.com/a.jsonl?x=1')
    expect(redactUrl('https://example.com/a.jsonl')).toBe('https://example.com/a.jsonl')
    expect(redactUrl('not a url')).toBe('not a url')
  })

  it('isCrossOrigin compares origins conservatively', () => {
    expect(isCrossOrigin('https://other.example/x', 'https://app.example')).toBe(true)
    expect(isCrossOrigin('https://app.example/x', 'https://app.example')).toBe(false)
    expect(isCrossOrigin('garbage', 'https://app.example')).toBe(false)
    expect(isCrossOrigin('https://other.example/x', undefined)).toBe(false)
  })
})

// ============================================================================
// UrlDownloader — URL rules
// ============================================================================

const PAYLOAD = encode('[{"id":1}]\n[{"id":2}]\n')

describe('UrlDownloader URL rules', () => {
  it('rejects non-http(s) URLs before any network I/O', async () => {
    const { impl, calls } = makeFetch(PAYLOAD)
    const downloader = new UrlDownloader({ fetchImpl: impl, storage: null })
    await expect(downloader.download('ftp://example.com/x.jsonl')).rejects.toBeInstanceOf(UrlValidationError)
    await expect(downloader.download('not a url')).rejects.toThrow(/not a parseable URL/)
    expect(calls.length).toBe(0)
  })

  it('sends sanitized headers on the wire and drops forbidden ones', async () => {
    const { impl, calls } = makeFetch(PAYLOAD, { chunks: [PAYLOAD.length] })
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage: null,
      headers: { 'X-Custom': 'kept', Host: 'evil', 'Content-Length': '5', Authorization: 'Bearer tok' },
    })
    await downloader.download('https://example.com/x.jsonl')
    expect(calls.length).toBe(1)
    expect(calls[0]!.headers).toEqual({ 'X-Custom': 'kept', Authorization: 'Bearer tok' })
  })

  it('rejects invalid custom header names with a typed error', async () => {
    const { impl, calls } = makeFetch(PAYLOAD)
    const downloader = new UrlDownloader({ fetchImpl: impl, storage: null, headers: { 'Bad Header': 'x' } })
    await expect(downloader.download('https://example.com/x.jsonl')).rejects.toBeInstanceOf(UrlInvalidHeadersError)
    expect(calls.length).toBe(0)
  })

  it('never puts credentials from the URL into error messages', async () => {
    const { impl } = makeFetch(PAYLOAD, { networkError: true })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage: null })
    const url = 'https://user:secretpass@example.com/x.jsonl'
    await expect(downloader.download(url)).rejects.toMatchObject({ name: 'UrlFetchError' })
    try {
      await downloader.download(url)
    } catch (error) {
      expect((error as Error).message).not.toContain('secretpass')
      expect((error as Error).message).toContain('https://example.com/x.jsonl')
    }
  })

  it('classifies cross-origin fetch failures as CORS denied', async () => {
    const { impl } = makeFetch(PAYLOAD, { networkError: true })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage: null, pageOrigin: 'https://app.example' })
    await expect(downloader.download('https://data.example/x.jsonl')).rejects.toBeInstanceOf(UrlCorsDeniedError)
    expect(new UrlCorsDeniedError('https://u:p@example.com/x').message).not.toContain('u:p@')
  })

  it('classifies same-origin fetch failures as URL_FETCH_FAILED', async () => {
    const { impl } = makeFetch(PAYLOAD, { networkError: true })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage: null, pageOrigin: 'https://app.example' })
    await expect(downloader.download('https://app.example/x.jsonl')).rejects.toBeInstanceOf(UrlFetchError)
  })

  it('classifies redirect loops as redirect denied', async () => {
    const { impl } = makeFetch(PAYLOAD, { networkError: true, fetchError: 'Redirected request loop' })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage: null })
    await expect(downloader.download('https://example.com/x.jsonl')).rejects.toBeInstanceOf(UrlRedirectDeniedError)
    expect(new UrlRedirectDeniedError('x').code).toBe('URL_REDIRECT_DENIED')
  })

  it('uses the final (redirected) URL for the name and result', async () => {
    const { impl } = makeFetch(PAYLOAD, {
      redirected: true,
      finalUrl: 'https://cdn.example.com/files/real-name.jsonl',
    })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage: null })
    const result = await downloader.download('https://example.com/short')
    expect(result.finalUrl).toBe('https://cdn.example.com/files/real-name.jsonl')
    expect(result.name).toBe('real-name.jsonl')
  })

  it('denies redirects whose final target is not http(s)', async () => {
    const { impl } = makeFetch(PAYLOAD, { redirected: true, finalUrl: 'ftp://example.com/x.jsonl' })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage: null })
    await expect(downloader.download('https://example.com/x.jsonl')).rejects.toBeInstanceOf(UrlRedirectDeniedError)
  })

  it('treats a missing response body as an empty document', async () => {
    const { impl } = makeFetch(PAYLOAD, { noBody: true, noContentLength: true })
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage: null,
      onFallbackRequest: async () => true, // size unknown → consent required
    })
    const result = await downloader.download('https://example.com/x.jsonl')
    expect(await result.spool.getSize()).toBe(0n)
  })

  it('fires onSpoolCreated before the first progress with spool + final URL', async () => {
    const { impl } = makeFetch(PAYLOAD, { chunks: [5, 5, 100] })
    const events: string[] = []
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage: null,
      onSpoolCreated: (info) => {
        events.push(`spool:${info.spool.kind}`)
        expect(info.finalUrl).toBe('https://example.com/x.jsonl')
        expect(info.declaredBytes).toBe(BigInt(PAYLOAD.length))
      },
      onProgress: () => {
        events.push('progress')
      },
    })
    await downloader.download('https://example.com/x.jsonl')
    expect(events[0]).toBe('spool:memory')
    expect(events.slice(1).every((e) => e === 'progress')).toBe(true)
    expect(events.length).toBeGreaterThan(1)
  })

  it('propagates async onProgress rejections (aborted incremental index)', async () => {
    const { impl } = makeFetch(PAYLOAD, { chunks: [5, 5, 100] })
    const controller = new AbortController()
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage: null,
      signal: controller.signal,
      onProgress: async () => {
        controller.abort()
        throw new IndexAbortedError()
      },
    })
    await expect(downloader.download('https://example.com/x.jsonl')).rejects.toBeInstanceOf(IndexAbortedError)
  })
})
