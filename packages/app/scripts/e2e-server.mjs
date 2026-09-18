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
 *     /e2e-fixture/jsonl — true streaming: rows are generated and written
 *       one at a time (nothing large accumulates in server memory), so
 *       `bytes=` can target multi-GB transfers for perf/soak runs.
 *       Query: rows=N (exact row count, classic mode, ≤ 100k) OR
 *       bytes=B (stream until ≥ B bytes, ≤ 8 GiB) [&rowBytes=R (pad rows
 *       to exactly R bytes, ≤ 512 KiB — makes `bytes=` yield an exact
 *       size)] [&delayMs=M (sleep M ms every 2 KiB of plain data)]
 *       [&gzip=1 (streaming content-encoding)] [&chunked=1 (no
 *       Content-Length)] [&lie-length=1, rows mode only: the server
 *       advertises HALF the real body size — a buggy/lying
 *       Content-Length; the client must handle the truncated transfer
 *       without hanging; a LARGER lie would stall the TCP transfer
 *       itself and is not representable];
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
import { createGzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, '..', 'e2e', 'fixtures')
const PORT = Number(process.env['PORT'] ?? 4173)
const NITRO_PORT = Number(process.env['NITRO_PORT'] ?? 4174)

/**
 * Fail fast if the nitro port is already taken: a STALE nitro from a
 * previous session would otherwise serve an old build under this
 * server's port 4173, producing mysteriously stale pages (this exact
 * trap was hit in TSK0052).
 */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') reject(err)
      else probe.close()
    })
    probe.once('listening', () => {
      probe.close(() => resolve())
    })
    probe.listen(port, '127.0.0.1')
  })
}

// MUST be awaited BEFORE spawning nitro: a stale nitro on the port would
// otherwise serve an OLD build under this server (this trap was hit in
// TSK0052). Fail fast with an actionable message.
try {
  await assertPortFree(NITRO_PORT)
} catch (err) {
  console.error(
    `e2e-server: port ${NITRO_PORT} is already in use — kill the stale ` +
      `process (e.g. 'fuser -k ${NITRO_PORT}/tcp') and retry. Refusing ` +
      `to proxy to a server that may be serving an old build.`,
  )
  process.exit(1)
}

const nitro = spawn('node', [join(here, '..', '.output', 'server', 'index.mjs')], {
  env: { ...process.env, NITRO_PORT: String(NITRO_PORT), NITRO_HOST: '127.0.0.1' },
  stdio: ['ignore', 'inherit', 'inherit'],
})

// A nitro that crashes (e.g. cannot bind) must take this server down with
// it — a proxy to a dead upstream only produces confusing 500s.
nitro.on('exit', (code) => {
  console.error(`e2e-server: nitro exited (code ${code}) — shutting down`)
  process.exit(code ?? 1)
})

// The nitro child MUST die with this server: orphaned children keep the
// port (and the old build) alive for the next run.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    nitro.kill(signal)
    process.exit(0)
  })
}

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

// 100k rows ≈ 6.8 MB — above the 1 MiB OPFS part size so storage tests can
// force at least one immutable part file (rows are generated on demand).
const MAX_FIXTURE_ROWS = 100_000

function intParam(params, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = params.get(name)
  if (raw === null) return fallback
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value) || value < 0 || value > max) {
    throw new Error(`invalid ${name}: ${raw}`)
  }
  return value
}

/**
 * One JSONL row. Without rowBytes: small, stable, ~60-80 bytes (the
 * classic fixture shape). With rowBytes>0: padded to EXACTLY rowBytes so
 * a `bytes=` target yields a predictable total size (perf budgets / soak).
 */
function fixtureRow(i, rowBytes) {
  if (rowBytes === undefined || rowBytes <= 0) {
    return Buffer.from(`{"i":${i},"pad":"${'x'.repeat(48)}"}\n`)
  }
  const base = Buffer.byteLength(`{"i":${i},"pad":"`)
  const tail = Buffer.byteLength('"}\n')
  const pad = Math.max(0, rowBytes - base - tail)
  return Buffer.from(`{"i":${i},"pad":"${'x'.repeat(pad)}"}\n`)
}

/**
 * EXACT total body length for rows mode. Row length varies with the
 * digit count of i (`"i":99999` is 5 bytes wider than `"i":0`) — a
 * `rows * fixtureRow(0).length` assumption declares a Content-Length
 * that is too SHORT and truncates the body mid-row (caught by TSK0053).
 * With rowBytes>0 every row is exactly rowBytes (the padding absorbs
 * the digit-count difference), so the total is uniform.
 */
function exactRowsLength(rows, rowBytes) {
  let total = 0
  for (let i = 0; i < rows; i++) {
    const base = Buffer.byteLength(`{"i":${i},"pad":"`)
    const tail = Buffer.byteLength('"}\n')
    total += rowBytes > 0 ? Math.max(rowBytes, base + tail) : base + tail + 48
  }
  return total
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function handleFixture(url, req, res) {
  const name = url.pathname.slice('/e2e-fixture/'.length)
  const params = url.searchParams

  if (name === 'jsonl') {
    // TSK0053: TRUE streaming — rows are generated and written one at a
    // time; nothing is accumulated in server memory, so `bytes=` can be
    // multi-GB. `rows=` keeps the classic small-fixture semantics.
    const rows = intParam(params, 'rows', 0, MAX_FIXTURE_ROWS)
    const targetBytes = intParam(params, 'bytes', 0, 8 * 1024 * 1024 * 1024)
    const rowBytes = intParam(params, 'rowBytes', 0, 512 * 1024)
    const delayMs = intParam(params, 'delayMs', 0, 10_000)
    const gzip = params.get('gzip') === '1'
    const chunked = params.get('chunked') === '1'
    const lieLength = params.get('lie-length') === '1'

    if (rows === 0 && targetBytes === 0) rows = 10 // classic default

    const headers = { 'content-type': 'application/jsonl' }
    if (gzip) headers['content-encoding'] = 'gzip'
    // Content-Length is only knowable in advance in rows mode (the
    // bytes mode stops mid-allocation at >= target). lie-length stays a
    // rows-mode feature: advertise HALF the real size (a buggy server);
    // the client must index what arrived without hanging or erroring.
    let declaredLength = null
    if (!gzip && !chunked && rows > 0) {
      const exact = exactRowsLength(rows, rowBytes)
      declaredLength = lieLength ? Math.floor(exact / 2) : exact
      headers['content-length'] = declaredLength
    }
    res.writeHead(200, headers)

    // Client-disconnect detection (TSK0053). The reliable signal is the
    // RESPONSE's 'close' before the response ended: the connection went
    // away. (req.aborted is deprecated and misfires; req's 'close' fires
    // when the REQUEST body is done — immediately for a body-less GET —
    // so neither works here.)
    let clientGone = false
    res.on('close', () => {
      if (!res.writableEnded) clientGone = true
    })

    // NOTE: stream.pipe(res) returns the DESTINATION — keep the gzip
    // stream itself if we want compressed output.
    let out
    if (gzip) {
      const gz = createGzip()
      gz.pipe(res) // pipe also ends res when gz finishes
      out = gz
    } else {
      out = res
    }
    let written = 0
    let sinceSleep = 0
    for (let i = 0; ; i++) {
      if (clientGone) return
      if (rows > 0 && i >= rows) break
      if (targetBytes > 0 && written >= targetBytes) break
      const row = fixtureRow(i, rowBytes)
      written += row.length
      sinceSleep += row.length
      // Honor backpressure: ignoring write()'s return value clogs the
      // socket write queue and kills ~80 MiB+ transfers with EINVAL
      // (TSK0053). 'drain' fires when the stream accepts data again —
      // for the gzip stream, pipe() propagates res backpressure into it.
      if (!out.write(row)) {
        // 'close' too: if the client disconnects while we are parked on
        // backpressure, 'drain' never fires and we would hang. Both
        // handlers must remove each other — a once('close') that never
        // fires would leak one listener per backpressure stall (11 in a
        // 200 MiB stream triggered Node's MaxListeners warning, TSK0053).
        await new Promise((resolve) => {
          const onDrain = () => {
            out.off('close', onClose)
            resolve()
          }
          const onClose = () => {
            out.off('drain', onDrain)
            resolve()
          }
          out.once('drain', onDrain)
          out.once('close', onClose)
        })
      }
      // Sleep cadence = every 2 KiB of plain data: identical pacing to
      // the pre-TSK0053 sliced writer (existing timing tests rely on it).
      if (delayMs > 0 && sinceSleep >= 2048) {
        sinceSleep = 0
        await sleep(delayMs)
      }
      if (rows === 0 && targetBytes === 0) break
    }
    if (gzip) {
      // Flush + finish the gzip stream, then end the response.
      await new Promise((resolve) => {
        out.end(resolve)
      })
    } else {
      res.end()
    }
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
