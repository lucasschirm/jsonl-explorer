import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer, isLoopbackHost, parseRange, RangeUnsatisfiable } from '../src/server.js'

const CAP = 'cap-test-0001'

function patternBytes(total: number): Uint8Array {
  const out = new Uint8Array(total)
  for (let i = 0; i < total; i++) out[i] = (i * 7 + 3) % 256
  return out
}

describe('parseRange (unit)', () => {
  const size = 100
  it('absent header → full file', () => {
    expect(parseRange(undefined, size)).toBeNull()
    expect(parseRange('', size)).toBeNull()
  })
  it('start-end', () => {
    expect(parseRange('bytes=10-19', size)).toEqual({ start: 10, end: 19 })
  })
  it('open-ended start-', () => {
    expect(parseRange('bytes=90-', size)).toEqual({ start: 90, end: 99 })
  })
  it('suffix -N (last N bytes)', () => {
    expect(parseRange('bytes=-25', size)).toEqual({ start: 75, end: 99 })
    expect(parseRange('bytes=-500', size)).toEqual({ start: 0, end: 99 })
  })
  it('end beyond length is clamped, not rejected (RFC 7233)', () => {
    expect(parseRange('bytes=95-9999', size)).toEqual({ start: 95, end: 99 })
  })
  it.each([
    'bytes=100-', // start == size
    'bytes=200-300', // start > size
    'bytes=10-5', // start > end
    'bytes=-0', // zero-length suffix
    'bytes=0-9,20-29', // multi-range: not supported → unsatisfiable
    'bytes=abc', // garbage
    'bytes=-', // empty
  ])('rejects %s', (header) => {
    expect(() => parseRange(header, size)).toThrow(RangeUnsatisfiable)
  })
})

describe('isLoopbackHost (unit)', () => {
  it('accepts exact loopback hostnames (with ports)', () => {
    expect(isLoopbackHost('127.0.0.1:4173')).toBe(true)
    expect(isLoopbackHost('localhost:4173')).toBe(true)
    expect(isLoopbackHost('[::1]:4173')).toBe(true)
    expect(isLoopbackHost('LOCALHOST:4173')).toBe(true)
  })
  it('rejects look-alikes, other hosts, and garbage (no prefix matching)', () => {
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackHost('evil127.0.0.1.com')).toBe(false)
    expect(isLoopbackHost('0.0.0.0:4173')).toBe(false)
    expect(isLoopbackHost('192.168.1.10:4173')).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
    expect(isLoopbackHost('not a host')).toBe(false)
  })
})

describe('createServer (integration, ephemeral port)', () => {
  let dir: string
  let file: string
  let data: Uint8Array
  let port: number
  let server: Awaited<ReturnType<typeof createServer>>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jsonlex-server-'))
    data = patternBytes(100)
    file = join(dir, 'data.jsonl')
    writeFileSync(file, data)
    server = await createServer({ file, port: 0, host: '127.0.0.1', capability: CAP, local: false })
    port = (server.server.address() as AddressInfo).port
  })

  afterEach(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const base = () => `http://127.0.0.1:${port}`
  const fileUrl = () => `${base()}/${CAP}/file.jsonl`
  // Remote mode: the file endpoint requires the hosted explorer's Origin.
  const HOSTED = 'https://jsonlexplorer.lucasschirm.com'
  const authFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetch(url, {
      ...init,
      headers: { origin: HOSTED, ...(init.headers as Record<string, string> | undefined) },
    })

  it('serves the full file with content headers', async () => {
    const res = await authFetch(fileUrl())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/jsonl')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-range')).toBeNull()
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBe(100)
    for (let i = 0; i < 100; i++) expect(body[i]).toBe(data[i])
  })

  it('serves an exact byte range (206 + Content-Range)', async () => {
    const res = await authFetch(fileUrl(), { headers: { range: 'bytes=10-19' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(body)).toEqual(Array.from(data.slice(10, 20)))
  })

  it('serves open-ended and suffix ranges', async () => {
    const open = await authFetch(fileUrl(), { headers: { range: 'bytes=95-' } })
    expect(open.status).toBe(206)
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(data.slice(95) as unknown as Uint8Array)

    const suffix = await authFetch(fileUrl(), { headers: { range: 'bytes=-25' } })
    expect(suffix.status).toBe(206)
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(data.slice(75) as unknown as Uint8Array)
  })

  it('clamps an over-long range instead of rejecting it', async () => {
    const res = await authFetch(fileUrl(), { headers: { range: 'bytes=95-9999' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 95-99/100')
  })

  it('answers 416 with the unsatisfied range form for unsatisfiable ranges', async () => {
    const res = await authFetch(fileUrl(), { headers: { range: 'bytes=100-' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */100')
  })

  it('answers 416 for multi-range and garbage range headers', async () => {
    for (const range of ['bytes=0-9,20-29', 'bytes=abc']) {
      const res = await authFetch(fileUrl(), { headers: { range } })
      expect(res.status).toBe(416)
    }
  })

  it('HEAD returns metadata without a body', async () => {
    const res = await authFetch(fileUrl(), { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('100')
    expect(await res.text()).toBe('')
  })

  it('an empty file: 200 with length 0; any range is 416', async () => {
    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '')
    const s2 = await createServer({ file: empty, port: 0, host: '127.0.0.1', capability: CAP, local: false })
    const p2 = (s2.server.address() as AddressInfo).port
    const res = await fetch(`http://127.0.0.1:${p2}/${CAP}/file.jsonl`, { headers: { origin: HOSTED } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('0')
    expect(await res.arrayBuffer()).toBeInstanceOf(ArrayBuffer)
    const ranged = await fetch(`http://127.0.0.1:${p2}/${CAP}/file.jsonl`, {
      headers: { range: 'bytes=0-', origin: HOSTED },
    })
    expect(ranged.status).toBe(416)
    expect(ranged.headers.get('content-range')).toBe('bytes */0')
    await s2.close()
  })

  it('wrong capability → 404 (no metadata, no method advertisement)', async () => {
    const get = await fetch(`${base()}/wrong-cap/file.jsonl`)
    expect(get.status).toBe(404)
    const post = await fetch(`${base()}/wrong-cap/file.jsonl`, { method: 'POST' })
    expect(post.status).toBe(404)
    // POST on the REAL route is also 404 (no 405: methods are not advertised).
    const postReal = await authFetch(fileUrl(), { method: 'POST' })
    expect(postReal.status).toBe(404)
  })

  it('path traversal attempts never resolve to the file', async () => {
    for (const path of [
      `/${CAP}/..%2f..%2fetc%2fpasswd`,
      `/${CAP}/../file.jsonl`,
      `/..%2f${CAP}%2ffile.jsonl`,
      `/${CAP}/file.jsonl.txt`,
    ]) {
      const res = await fetch(`${base()}${path}`)
      expect(res.status).toBe(404)
    }
  })

  it('rejects non-loopback Host headers (including look-alikes) with 403', async () => {
    const withHost = (host: string): Promise<{ status: number }> =>
      new Promise((resolvePromise, rejectPromise) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: `/${CAP}/file.jsonl`,
            method: 'GET',
            headers: { host, origin: HOSTED },
          },
          (res) => {
            res.resume()
            res.on('end', () => resolvePromise({ status: res.statusCode ?? 0 }))
          },
        )
        req.on('error', rejectPromise)
        req.end()
      })

    expect((await withHost('127.0.0.1.evil.com')).status).toBe(403)
    expect((await withHost('192.168.1.10')).status).toBe(403)
    expect((await withHost('127.0.0.1')).status).toBe(200)
    expect((await withHost('localhost')).status).toBe(200)
  })

  it('rejects a foreign Origin with 403 (remote mode)', async () => {
    const res = await fetch(fileUrl(), { headers: { origin: 'https://evil.com' } })
    expect(res.status).toBe(403)
  })

  it('allows the hosted explorer origin (exact, never wildcard)', async () => {
    const res = await fetch(fileUrl(), {
      headers: { origin: 'https://jsonlexplorer.lucasschirm.com' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://jsonlexplorer.lucasschirm.com')
    expect(res.headers.get('vary')).toBe('Origin')
    // PNA is required for the hosted (less private) page → loopback.
    expect(res.headers.get('access-control-allow-private-network')).toBe('true')
  })

  it('denies an ABSENT origin in remote mode (non-browser clients are out of scope)', async () => {
    const res = await fetch(fileUrl())
    expect(res.status).toBe(403)
  })

  it('answers an authorized hosted preflight with 204 + exact CORS headers', async () => {
    const res = await fetch(fileUrl(), {
      method: 'OPTIONS',
      headers: {
        origin: 'https://jsonlexplorer.lucasschirm.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'range',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://jsonlexplorer.lucasschirm.com')
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS')
    expect(res.headers.get('access-control-allow-headers')).toBe('Range')
    expect(res.headers.get('access-control-allow-private-network')).toBe('true')
  })

  it('rejects a malicious preflight with 403 and NO CORS headers', async () => {
    const res = await fetch(fileUrl(), {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.com',
        'access-control-request-method': 'GET',
      },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('never reflects a wildcard origin', async () => {
    for (const origin of ['https://evil.com', 'null', '']) {
      const res = await fetch(fileUrl(), origin === '' ? {} : { headers: { origin } })
      expect(res.status).toBe(403)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('--local: absent origin (same-origin GET) is allowed; foreign origin is not', async () => {
    const s2 = await createServer({ file, port: 0, host: '127.0.0.1', capability: CAP, local: true })
    const p2 = (s2.server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${p2}/${CAP}/file.jsonl`

    const noOrigin = await fetch(url)
    expect(noOrigin.status).toBe(200)
    // Same-origin: the exact loopback origin is reflected, no PNA needed.
    expect(noOrigin.headers.get('access-control-allow-origin')).toBe(`http://127.0.0.1:${p2}`)
    expect(noOrigin.headers.get('access-control-allow-private-network')).toBeNull()

    const localOrigin = await fetch(url, { headers: { origin: `http://127.0.0.1:${p2}` } })
    expect(localOrigin.status).toBe(200)

    const foreign = await fetch(url, { headers: { origin: 'http://127.0.0.1:9999' } })
    expect(foreign.status).toBe(403)

    s2.server.closeAllConnections?.()
    await s2.close()
  })

  it('streams a large file byte-exactly (bounded server memory by construction)', async () => {
    const big = patternBytes(8 * 1024 * 1024)
    const bigFile = join(dir, 'big.jsonl')
    writeFileSync(bigFile, big)
    const s2 = await createServer({ file: bigFile, port: 0, host: '127.0.0.1', capability: CAP, local: false })
    const p2 = (s2.server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${p2}/${CAP}/file.jsonl`

    const res = await fetch(url, { headers: { origin: HOSTED } })
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBe(big.length)
    for (let i = 0; i < big.length; i += 99991) expect(body[i]).toBe(big[i])

    const ranged = await fetch(url, { headers: { range: 'bytes=0-65535', origin: HOSTED } })
    expect(ranged.status).toBe(206)
    const rangedBody = new Uint8Array(await ranged.arrayBuffer())
    expect(rangedBody.length).toBe(65536)
    for (let i = 0; i < 65536; i += 997) expect(rangedBody[i]).toBe(big[i])

    await s2.close()
  })

  it('releases the read on client disconnect and stays healthy', async () => {
    const bigFile = join(dir, 'big2.jsonl')
    writeFileSync(bigFile, patternBytes(4 * 1024 * 1024))
    const s2 = await createServer({ file: bigFile, port: 0, host: '127.0.0.1', capability: CAP, local: false })
    const p2 = (s2.server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${p2}/${CAP}/file.jsonl`

    // Start a request, then abort it mid-stream.
    const controller = new AbortController()
    const promise = fetch(url, { signal: controller.signal, headers: { origin: HOSTED } })
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()
    await promise.catch(() => {}) // aborted

    // The server must still serve full, correct responses afterwards.
    const res = await fetch(url, { headers: { origin: HOSTED } })
    expect(res.status).toBe(200)
    expect((new Uint8Array(await res.arrayBuffer())).length).toBe(4 * 1024 * 1024)

    // The aborted connection may linger in the client pool: drop all
    // sockets so close() cannot wait on it.
    s2.server.closeAllConnections?.()
    await s2.close()
  }, 20_000)

  it('--local serves the staged site: index 200, no directory listing', async () => {
    const s2 = await createServer({ file, port: 0, host: '127.0.0.1', capability: CAP, local: true })
    const p2 = (s2.server.address() as AddressInfo).port
    const index = await fetch(`http://127.0.0.1:${p2}/`)
    expect(index.status).toBe(200)
    expect((index.headers.get('content-type') ?? '').includes('text/html')).toBe(true)
    // A directory without listing → 404, not an auto-index.
    const listing = await fetch(`http://127.0.0.1:${p2}/_nuxt/`)
    expect(listing.status).toBe(404)
    // Traversal attempts against the static root: 404 (the plugin's guard
    // throws 'Forbidden'; the error handler maps it to the 404 contract).
    const traversal = await fetch(`http://127.0.0.1:${p2}/..%2f..%2fetc%2fpasswd`)
    expect(traversal.status).toBe(404)
    expect(await traversal.json()).toEqual({ error: 'Not found' })
    s2.server.closeAllConnections?.()
    await s2.close()
  })

  it('refuses to listen when the file is a directory', async () => {
    await expect(
      createServer({ file: dir, port: 0, host: '127.0.0.1', capability: CAP, local: false }),
    ).rejects.toThrow('Not a regular file')
  })

  it('refuses to listen when the file is not readable (skipped under root)', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return // root bypasses R_OK; nothing to assert
    }
    const noRead = join(dir, 'noread.jsonl')
    writeFileSync(noRead, 'x\n')
    chmodSync(noRead, 0o000)
    await expect(
      createServer({ file: noRead, port: 0, host: '127.0.0.1', capability: CAP, local: false }),
    ).rejects.toThrow()
  })

  it('/health answers ok', async () => {
    const res = await fetch(`${base()}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
