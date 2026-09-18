/**
 * E2E web server (TSK0039) — fronts the REAL nitro preview server.
 *
 * Why not `nuxi preview` alone: nitro only serves public files that
 * existed at BUILD time, so test fixtures copied in later get the SPA
 * fallback instead. This server:
 *
 * - serves same-origin fixtures from `e2e/fixtures/` under
 *   `/e2e-host/*` (handover host pages + the ?url= bootstrap data file,
 *   which records the Referer header it receives — the no-referrer
 *   assertion), with `GET /e2e-host/__seen` exposing the recordings to
 *   the test process;
 * - generates controlled DATA endpoints under `/e2e-fixture/*` (nothing
 *   large is committed — bodies are produced on demand):
 *     /e2e-fixture/jsonl?rows=N&delayMs=M[&gzip=1][&chunked=1][&lie-length=1]
 *       N JSONL rows; per-chunk delay; gzip content-encoding; chunked
 *       (no Content-Length); lie-length = gzip with the UNCOMPRESSED
 *       length advertised (misleading/buggy server case);
 *     /e2e-fixture/headers — echoes selected request headers (JSON);
 *     /e2e-fixture/redirect?to=<url>&hops=N — N-hop 302 chain;
 *     /e2e-fixture/error?status=404|500 — typed error responses;
 *     /e2e-fixture/cors-deny — 200 without any CORS headers.
 * - proxies EVERYTHING else (headers, SPA fallback, assets, API) to
 *   nitro, so the app is exercised exactly as deployed.
 *
 * Run: `node scripts/e2e-server.mjs` (listens on PORT, default 4173).
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, '..', 'e2e', 'fixtures')
const PORT = Number(process.env['PORT'] ?? 4173)
const NITRO_PORT = Number(process.env['NITRO_PORT'] ?? 4174)

const nitro = spawn('node', [join(here, '..', '.output', 'server', 'index.mjs')], {
  env: { ...process.env, NITRO_PORT: String(NITRO_PORT), NITRO_HOST: '127.0.0.1' },
  stdio: ['ignore', 'inherit', 'inherit'],
})

const seen = []

const server = http.createServer(async (req, res) => {
  const rawUrl = req.url ?? '/'
  const url = new URL(rawUrl, `http://127.0.0.1:${PORT}`)

  // Same-origin test fixtures (handover hosts, bootstrap data, recordings).
  if (url.pathname === '/e2e-host/__seen') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(seen))
    return
  }
  if (url.pathname.startsWith('/e2e-host/')) {
    const name = url.pathname.slice('/e2e-host/'.length)
    const file = join(FIXTURES, name)
    if (name === 'data.jsonl') {
      const referer = req.headers['referer']
      seen.push({ path: rawUrl, referer: Array.isArray(referer) ? referer[0] ?? null : (referer ?? null) })
    }
    if (existsSync(file)) {
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/jsonl'
      res.writeHead(200, { 'content-type': type })
      res.end(readFileSync(file))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('fixture not found')
    return
  }

  // Generated data endpoints (controlled streams / headers / errors).
  if (url.pathname.startsWith('/e2e-fixture/')) {
    try {
      await handleFixture(url, req, res)
      return
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `fixture error: ${error instanceof Error ? error.message : String(error)}` }))
      return
    }
  }

  // Everything else: the real nitro server (headers + SPA fallback).
  try {
    const upstream = await fetch(`http://127.0.0.1:${NITRO_PORT}${url.pathname}${url.search}`, {
      method: req.method,
      headers: { host: `127.0.0.1:${NITRO_PORT}`, ...req.headers },
      body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : req,
      redirect: 'manual',
    })
    const headers = Object.fromEntries(upstream.headers.entries())
    res.writeHead(upstream.status, headers)
    if (upstream.body) {
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } else {
      res.end()
    }
  } catch (error) {
    // The upstream can die mid-body (e.g. the server being torn down): the
    // headers may already be sent, and a second writeHead would crash the
    // whole e2e server (and every following test) with ERR_HTTP_HEADERS_SENT.
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' })
    }
    res.end(`e2e proxy error: ${error instanceof Error ? error.message : String(error)}`)
  }
})

server.listen(PORT, () => {
  console.log(`e2e server on http://127.0.0.1:${PORT} (nitro on :${NITRO_PORT})`)
})

process.on('SIGTERM', () => {
  nitro.kill()
  server.close()
  process.exit(0)
})
process.on('SIGINT', () => {
  nitro.kill()
  server.close()
  process.exit(0)
})

// --- Generated data fixtures (TSK0045) --------------------------------------

const MAX_FIXTURE_ROWS = 10_000

function intParam(params, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = params.get(name)
  if (raw === null) return fallback
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value) || value < 0 || value > max) {
    throw new Error(`invalid ${name}: ${raw}`)
  }
  return value
}

/** One JSONL row: small, stable, ~60-80 bytes. */
function fixtureRow(i) {
  return Buffer.from(`{"i":${i},"pad":"${'x'.repeat(48)}"}\n`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function handleFixture(url, req, res) {
  const name = url.pathname.slice('/e2e-fixture/'.length)
  const params = url.searchParams

  if (name === 'jsonl') {
    const rows = intParam(params, 'rows', 10, MAX_FIXTURE_ROWS)
    const delayMs = intParam(params, 'delayMs', 0, 10_000)
    const gzip = params.get('gzip') === '1'
    const chunked = params.get('chunked') === '1'
    const lieLength = params.get('lie-length') === '1'

    // Build the logical body, then optionally compress. Chunk size is
    // fixed so slow streams interleave with the indexer deterministically.
    const chunks = []
    const CHUNK_ROWS = 5
    for (let i = 0; i < rows; i += CHUNK_ROWS) {
      const part = []
      for (let j = i; j < Math.min(i + CHUNK_ROWS, rows); j++) part.push(fixtureRow(j))
      chunks.push(Buffer.concat(part))
    }
    const plain = Buffer.concat(chunks)
    const body = gzip ? gzipSync(plain) : plain

    const headers = { 'content-type': 'application/jsonl' }
    if (gzip) headers['content-encoding'] = 'gzip'
    if (!chunked) {
      // lie-length: advertise the UNCOMPRESSED size while serving gzip —
      // a buggy/misleading server (clients must not trust the length).
      headers['content-length'] = lieLength ? plain.length : body.length
    }
    res.writeHead(200, headers)
    if (body.length === 0) {
      res.end()
      return
    }
    // Stream in slices so delayMs produces real mid-stream waits.
    // Small slices: delayMs produces real mid-stream waits even for
    // modest bodies (clients see 'complete' once all Content-Length bytes
    // arrived, so single-large-chunk bodies would never wait).
    const SLICE = 2 * 1024
    for (let offset = 0; offset < body.length; offset += SLICE) {
      if (req.aborted) return
      res.write(body.subarray(offset, Math.min(offset + SLICE, body.length)))
      if (delayMs > 0) await sleep(delayMs)
    }
    res.end()
    return
  }

  if (name === 'headers') {
    const picked = ['referer', 'origin', 'user-agent', 'range', 'x-test-marker']
      .filter((h) => req.headers[h] !== undefined)
      .map((h) => ({ header: h, value: req.headers[h] }))
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ headers: picked }))
    return
  }

  if (name === 'redirect') {
    const to = params.get('to')
    const hops = intParam(params, 'hops', 1, 5)
    if (!to || hops <= 0) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('redirect requires ?to=<url> and hops>=1')
      return
    }
    // One hop consumed per request: /redirect?to=X&hops=N -> 302 to
    // /redirect?to=X&hops=N-1 ... -> 302 to X. (Same-origin chain.)
    res.writeHead(302, { location: hops === 1 ? to : url.pathname + `?to=${encodeURIComponent(to)}&hops=${hops - 1}` })
    res.end()
    return
  }

  if (name === 'error') {
    const status = intParam(params, 'status', 500, 599)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `fixture error (status ${status})` }))
    return
  }

  if (name === 'cors-deny') {
    // 200 with NO Access-Control-Allow-Origin: a cross-origin reader is
    // denied by the browser. (Same-origin callers are unaffected — the
    // endpoint exists for CLI/hosted-origin scenarios.)
    res.writeHead(200, { 'content-type': 'application/jsonl' })
    res.end('{"cors":"denied"}\n')
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('unknown fixture')
}
