/**
 * Fastify server for jsonlex CLI (TSK0041)
 *
 * Serves exactly one validated local regular file behind a
 * capability-protected route, and optionally the static explorer site
 * (--local mode).
 *
 * Security contract:
 * - the file is resolved and readability-checked BEFORE the server listens;
 * - the capability is a per-run 256-bit random hex token embedded in the
 *   route path (a wrong token is just a non-matching route: 404, no
 *   metadata, no timing side channel on the file);
 * - the Host header must be a LOOPBACK host (exact hostname match —
 *   `127.0.0.1.evil.com` does NOT pass a prefix check);
 * - ranges follow RFC 7233: single range only (multi-range → 416),
 *   `start-end` (end clamped to file length), `start-`, suffix `-N`,
 *   unsatisfiable → 416 with the unsatisfied Content-Range form;
 * - responses stream from the file (bounded server memory), `no-store`,
 *   no directory listing, dotfiles not served (--local);
 * - CORS allows only the hosted explorer origin (remote) or the loopback
 *   origin itself (--local).
 */

import fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { accessSync, constants as fsConstants, createReadStream, statSync } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface ServerOptions {
  file: string
  port: number
  host: string
  capability: string
  local: boolean
}

const HOSTED_ORIGIN = 'https://jsonlexplorer.lucasschirm.com'

/** True only for exact loopback hostnames (never a prefix/suffix match). */
export function isLoopbackHost(hostHeader: string): boolean {
  let hostname: string
  try {
    // Note: URL keeps the brackets on IPv6 literals ('[::1]').
    hostname = new URL(`http://${hostHeader}`).hostname
  } catch {
    return false
  }
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

export interface ParsedRange {
  start: number
  end: number // inclusive
}

/**
 * Parses a single-range `Range: bytes=...` header against fileSize.
 * Returns null when the header is absent or empty (full response), or
 * throws RangeUnsatisfiable for a present-but-invalid/unsatisfiable range.
 */
export function parseRange(header: string | undefined, fileSize: number): ParsedRange | null {
  if (header === undefined || header === '') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) throw new RangeUnsatisfiable(fileSize) // multi-range / garbage
  // The regex guarantees both groups; `?? ''` satisfies noUncheckedIndexedAccess.
  const startStr = match[1] ?? ''
  const endStr = match[2] ?? ''
  if (startStr === '' && endStr === '') throw new RangeUnsatisfiable(fileSize) // "bytes=-"

  if (startStr === '') {
    // Suffix: the LAST endStr bytes.
    const suffix = Number.parseInt(endStr, 10)
    if (suffix === 0) throw new RangeUnsatisfiable(fileSize)
    return { start: Math.max(0, fileSize - suffix), end: fileSize - 1 }
  }

  const start = Number.parseInt(startStr, 10)
  if (start >= fileSize) throw new RangeUnsatisfiable(fileSize)
  // RFC 7233: an end beyond the length is clamped, not rejected.
  const end = endStr === '' ? fileSize - 1 : Math.min(Number.parseInt(endStr, 10), fileSize - 1)
  if (start > end) throw new RangeUnsatisfiable(fileSize)
  return { start, end }
}

/** A present-but-unsatisfiable range: reply 416 + the unsatisfied range form. */
export class RangeUnsatisfiable extends Error {
  constructor(public readonly fileSize: number) {
    super('Range unsatisfiable')
  }
}

function getSitePath(): string {
  // In production, site is bundled in the package under 'site' directory
  // (staged by scripts/stage-site.mjs); in development, use the app's
  // generated output.
  const pkgSite = resolve(__dirname, '..', 'site')
  const devSite = resolve(__dirname, '..', '..', 'app', '.output', 'public')
  return existsSyncLocal(pkgSite) ? pkgSite : devSite
}

function existsSyncLocal(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Validates the file BEFORE any socket is opened (TSK0041). */
function assertReadableRegularFile(file: string): void {
  const stat = statSync(file)
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${file}`)
  }
  accessSync(file, fsConstants.R_OK)
}

export async function createServer(options: ServerOptions) {
  // Fail before listening: a bad file must never yield a running server
  // whose only error is a 500 on first request.
  assertReadableRegularFile(options.file)

  const server = fastify({ logger: false })

  // Security headers on every response.
  server.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Cache-Control', 'no-store')
    // Framing: the file endpoint must never be framed; in --local mode the
    // served site follows the app's own policy (same-origin embedding only).
    if (options.local) {
      reply.header('Content-Security-Policy', "frame-ancestors 'self'")
    } else {
      reply.header('X-Frame-Options', 'DENY')
    }
  })

  // Host + CORS policy for the FILE ENDPOINT (TSK0042). /health and the
  // --local static site are public-surface and skip the origin policy.
  //
  // CORS is convenience, NOT authorization: the capability token and the
  // loopback Host check are what protect the file. The policy:
  // - remote mode: the requesting page MUST be the hosted explorer
  //   (exact Origin; an absent Origin — e.g. a non-browser client — is
  //   denied, since remote mode exists for the hosted page only);
  // - --local mode: the page is same-origin, so a plain GET carries no
  //   Origin (allowed); a present Origin must be exactly this loopback
  //   origin;
  // - never a wildcard: the exact origin is reflected, and rejected
  //   preflight/reads get 403 WITHOUT CORS headers (the browser then
  //   blocks them); Vary: Origin is set because the answer depends on it;
  // - PNA (Access-Control-Allow-Private-Network) is only needed when a
  //   less-private page talks to the loopback server — i.e. remote mode.
  const fileRoute = `/${options.capability}/file.jsonl`
  server.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    if (path !== fileRoute) return

    const origin = request.headers.origin ?? ''
    const host = request.headers.host ?? ''

    // Validate Host header first (exact loopback hostname match).
    if (!isLoopbackHost(host)) {
      reply.code(403)
      return reply.send({ error: 'Forbidden: Invalid host' })
    }

    const localOrigin = `http://${host}`
    const authorized = options.local
      ? origin === '' || origin === localOrigin // same-origin page
      : origin === HOSTED_ORIGIN // hosted explorer only
    if (!authorized) {
      reply.code(403) // no CORS headers: the browser blocks the response
      return reply.send({ error: 'Forbidden: Invalid origin' })
    }

    reply.header('Access-Control-Allow-Origin', options.local ? localOrigin : HOSTED_ORIGIN)
    reply.header('Vary', 'Origin')
    reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Range')
    reply.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
    if (!options.local) {
      // Private Network Access header for Chrome (hosted page → loopback).
      reply.header('Access-Control-Allow-Private-Network', 'true')
    }

    // Handle preflight (authorized origins only — see above).
    if (request.method === 'OPTIONS') {
      reply.code(204)
      return reply.send()
    }
  })

  // Capability-protected file endpoint. The capability is part of the
  // literal route: any other path (wrong token, traversal attempt, extra
  // segments) is simply not a route → 404.
  server.get(fileRoute, async (request, reply) => {
    const fileSize = statSync(options.file).size
    let range: ParsedRange | null = null
    try {
      range = parseRange(request.headers.range, fileSize)
    } catch (error) {
      if (error instanceof RangeUnsatisfiable) {
        reply.code(416)
        reply.header('Content-Range', `bytes */${fileSize}`)
        reply.header('Accept-Ranges', 'bytes')
        return reply.send()
      }
      throw error
    }
    const start = range?.start ?? 0
    const end = range?.end ?? fileSize - 1
    reply.header('Content-Type', 'application/jsonl')
    reply.header('Content-Length', String(end - start + 1))
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Cache-Control', 'no-store')
    if (range !== null) {
      reply.code(206)
      reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    }
    if (fileSize === 0) return reply.send()
    const stream = createReadStream(options.file, { start, end })
    request.raw.on('close', () => stream.destroy())
    return reply.send(stream)
  })

  server.head(fileRoute, async (request, reply) => {
    const fileSize = statSync(options.file).size
    reply.header('Content-Type', 'application/jsonl')
    reply.header('Content-Length', String(fileSize))
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Cache-Control', 'no-store')
    return reply.send()
  })

  // Anything not explicitly routed (wrong capability, traversal, methods):
  // 404 — never 405 (do not advertise which methods exist on the route).
  server.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not found' })
  })

  // Serve static site in --local mode (no listing, no dotfiles).
  if (options.local) {
    const sitePath = getSitePath()
    if (existsSyncLocal(sitePath)) {
      await server.register(fastifyStatic, {
        root: sitePath,
        prefix: '/',
        decorateReply: false,
        list: false, // no directory listings (v7 option name)
        dotfiles: 'ignore', // never serve dotfiles
        // TSK0043: the staged site is immutable per installed version —
        // hashed assets may be cached forever; document entries revalidate
        // so a CLI upgrade cannot serve a stale index.html.
        setHeaders: (res, path) => {
          if (path === '' || path.endsWith('/') || path.endsWith('.html')) {
            res.setHeader('cache-control', 'no-store')
          } else {
            res.setHeader('cache-control', 'public, max-age=31536000, immutable')
          }
        },
      })
    } else {
      console.warn(`Warning: Static site not found at ${sitePath}`)
    }
  }

  // Unexpected errors: log locally, reply with a generic body (no file
  // paths or internals in the response), keep the server alive. The static
  // plugin's traversal guard throws 'Forbidden'/'Not found' — those are
  // client-side path issues: same 404 contract as any unknown path.
  server.setErrorHandler((error, _request, reply) => {
    if (error.message === 'Forbidden' || error.message === 'Not found') {
      return reply.code(404).send({ error: 'Not found' })
    }
    console.error(`Server error: ${error.message}`)
    if (!reply.statusCode || reply.statusCode < 400) reply.code(500)
    reply.send({ error: 'Internal server error' })
  })

  // Health check
  server.get('/health', async () => ({ ok: true }))

  await server.listen({ port: options.port, host: options.host })
  return server
}
