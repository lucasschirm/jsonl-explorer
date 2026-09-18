/**
 * TSK0054 — post-deploy smoke against the live production URL.
 *
 * Runs after the Cloudflare Pages deploy (deploy.yml). Checks, over real
 * https, that the EXACT deployed output serves what the production-output
 * checks promised: direct routes, SPA fallback, 404 for missing assets,
 * the engine worker + jq WASM assets, security headers (CSP / referrer /
 * nosniff), and the document metadata.
 *
 * Usage: node scripts/post-deploy-smoke.mjs [baseUrl]
 * (default base: https://jsonlexplorer.lucasschirm.com)
 */
import { buildAppCsp, APP_SECURITY_HEADERS } from '@jsonl-explorer/shared'

const BASE = (process.argv[2] ?? 'https://jsonlexplorer.lucasschirm.com').replace(/\/$/, '')

let failures = 0
function check(label, ok, detail = '') {
  if (!ok) failures++
  console.log(`[smoke] ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function get(path, accept = '*/*') {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept },
    redirect: 'manual',
  })
  const body = await res.text()
  return { status: res.status, headers: res.headers, body }
}

async function main() {
  const expectedCsp = buildAppCsp()

  // 1) Direct routes: 200 + HTML.
  for (const route of ['/', '/about', '/docs', '/docs/getting-started', '/explorer']) {
    const r = await get(route, 'text/html')
    check(
      `route ${route} serves HTML`,
      r.status === 200 && r.body.includes('<html'),
      `status ${r.status}`,
    )
  }

  // 2) SPA fallback + 404 semantics.
  const spa = await get('/definitely-missing-route', 'text/html')
  check('unknown route -> SPA shell (200)', spa.status === 200 && spa.body.includes('<html'))
  const missing = await get('/definitely-missing.png')
  check('missing asset -> 404', missing.status === 404, `status ${missing.status}`)

  // 3) Metadata: the document title/description are live.
  const home = await get('/', 'text/html')
  check('title present', home.body.includes('<title>JSONL Explorer</title>'))
  check(
    'description meta present',
    home.body.includes('Explore, filter, edit and export multi-GB JSONL files'),
  )

  // 4) Worker + jq WASM assets exist at their hashed paths (extracted
  //    from the live shell — the same assets the app will fetch).
  const assetRefs = [...home.body.matchAll(/(?:href|src)="(\/_nuxt\/[^"]+)"/g)].map((m) => m[1])
  check('shell references _nuxt assets', assetRefs.length > 0, `${assetRefs.length} refs`)
  let workerOk = false
  let wasmOk = false
  for (const ref of assetRefs) {
    const r = await get(ref)
    if (r.status !== 200) check(`asset ${ref}`, false, `status ${r.status}`)
    if (/jsonl\.worker-[^/]+\.js$/.test(ref)) workerOk = r.status === 200
    if (/\.wasm$/.test(ref)) wasmOk = r.status === 200
  }
  // The worker is lazy-loaded (not in the shell refs) — find it via the
  // built asset manifest if the shell did not reference it directly.
  if (!workerOk || !wasmOk) {
    for (const ref of assetRefs) {
      if (workerOk && wasmOk) break
      const r = await get(ref)
      if (r.status !== 200) continue
      const found = [...r.body.matchAll(/["'](jsonl\.worker-[^"']+\.w?asm?\.js|jq\.wasm\.wasm)["']/g)]
      for (const m of found) {
        const name = m[1]
        const ar = await get(`/_nuxt/${name}`)
        if (/jsonl\.worker/.test(name)) workerOk = ar.status === 200
        if (/\.wasm$/.test(name)) wasmOk = ar.status === 200
      }
    }
  }
  check('engine worker asset reachable', workerOk)
  check('jq WASM asset reachable', wasmOk)

  // 5) Security headers on a route AND an asset. The CSP must be the
  // EXACT production policy (shared source of truth) — any drift is a
  // deploy failure.
  for (const [label, r] of [['route /', home], ['asset', await get(assetRefs[0] ?? '/favicon.svg')]]) {
    const csp = r.headers.get('content-security-policy') ?? ''
    check(`${label}: CSP matches production policy`, csp === expectedCsp, csp === expectedCsp ? '' : `got: ${csp || 'header absent'}`)
    check(`${label}: CSP frame-ancestors is 'self'`, csp.includes("frame-ancestors 'self'"))
    check(
      `${label}: referrer policy no-referrer`,
      (r.headers.get('referrer-policy') ?? '') === APP_SECURITY_HEADERS['Referrer-Policy'],
    )
    check(
      `${label}: nosniff`,
      (r.headers.get('x-content-type-options') ?? '') === APP_SECURITY_HEADERS['X-Content-Type-Options'],
    )
  }

  if (failures > 0) {
    console.error(`[smoke] ${failures} post-deploy check(s) failed — roll forward with a fix; the previous deploy is still live on Cloudflare Pages`)
    process.exit(1)
  }
  console.log('[smoke] production is healthy')
}

main().catch((err) => {
  console.error(`[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
