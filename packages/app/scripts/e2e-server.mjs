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
 * - proxies EVERYTHING else (headers, SPA fallback, assets, API) to
 *   nitro, so the app is exercised exactly as deployed.
 *
 * Run: `node scripts/e2e-server.mjs` (listens on PORT, default 4173).
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
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
