/**
 * TSK0054 — finalize + validate the static production output.
 *
 * 1. WRITES Cloudflare Pages' `_headers` into `.output/public`, generated
 *    from the shared CSP source of truth (packages/shared/src/csp.ts).
 *    Static hosting has no nitro routeRules, so the security headers
 *    (CSP, referrer policy, nosniff) + cache rules must come from the
 *    file; generating it (instead of committing it) makes drift from
 *    nuxt.config a CI failure, not a silent security gap.
 * 2. VALIDATES the output with the same resolution Cloudflare Pages
 *    uses (file > clean-URL `.html` > directory index > `200.html` SPA
 *    fallback for extensionless paths > `404.html`):
 *      - SPA shell + 404 documents exist;
 *      - every direct route resolves to HTML;
 *      - every internal href/src in the GENERATED HTML resolves (no
 *        broken links in the production build);
 *      - the engine worker + jq WASM assets exist in the output;
 *      - missing assets resolve to 404.
 *
 * Usage: node scripts/finalize-production-output.mjs
 * (operates on `.output/public` as left by `nuxi generate`)
 *
 * npm scripts (packages/app):
 *  - `check:production` = nuxi generate -> this script -> nuxi build.
 *    The trailing build restores `.output/server`, which `nuxi generate`
 *    deletes — the e2e suite (scripts/e2e-server.mjs) fronts the nitro
 *    server, so local `pnpm build` + e2e keeps working afterwards.
 *  - `finalize:production` = this script alone; the deploy workflow runs
 *    its own `nuxi generate` first and does NOT need the server build
 *    back (no e2e after the artifact upload).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAppCsp, APP_SECURITY_HEADERS } from '@jsonl-explorer/shared'

const here = dirname(fileURLToPath(import.meta.url))
const OUTPUT = resolvePath(here, '..', '.output', 'public')

function fail(message) {
  console.error(`[finalize] FAIL: ${message}`)
  process.exit(1)
}

/** Production handover origins: the deployed app is framed same-origin
 *  only (the CLI's hosted mode serves it from its own origin). */
function productionCsp() {
  if (process.env['VITE_HANDOVER_ALLOWED_ORIGINS']) {
    fail(
      'VITE_HANDOVER_ALLOWED_ORIGINS is set — the static _headers assumes ' +
        'the production default (same-origin framing). Build without it.',
    )
  }
  return buildAppCsp()
}

/** The `_headers` file: CF Pages applies the FIRST matching block, so
 *  every block carries the full security header set. */
function buildHeadersFile(csp) {
  const security = [
    `  Content-Security-Policy: ${csp}`,
    `  X-Content-Type-Options: ${APP_SECURITY_HEADERS['X-Content-Type-Options']}`,
    `  Referrer-Policy: ${APP_SECURITY_HEADERS['Referrer-Policy']}`,
    '  X-XSS-Protection: 1; mode=block',
  ]
  const blocks = [
    // Hashed build assets: immutable per deploy.
    ['/_nuxt/*', [...security, '  Cache-Control: public, max-age=31536000, immutable']],
    // HTML + content API: revalidate (a new deploy must not hide behind a cached shell).
    ['/*.html', [...security, '  Cache-Control: public, max-age=0, must-revalidate']],
    ['/api/*', [...security, '  Cache-Control: public, max-age=0, must-revalidate']],
    ['/*', [...security, '  Cache-Control: public, max-age=0, must-revalidate']],
  ]
  return blocks.map(([path, lines]) => `${path}\n${lines.join('\n')}`).join('\n\n') + '\n'
}

/** All files under dir (relative, posix-style). */
function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base))
    else out.push(full.slice(base.length + 1).split(sep).join('/'))
  }
  return out
}

/**
 * Cloudflare Pages resolution: file > clean-URL .html > directory index
 * > 200.html (SPA fallback, extensionless only) > 404.html.
 * Returns the resolved relative file (or null when the output is missing).
 */
function makeResolver(files) {
  const set = new Set(files)
  const isFile = (p) => set.has(p)
  return (urlPath) => {
    let p = urlPath.replace(/^\/+/, '').replace(/\/+$/, '')
    if (p === '') return isFile('index.html') ? 'index.html' : null
    if (isFile(p)) return p
    if (isFile(`${p}.html`)) return `${p}.html`
    if (isFile(`${p}/index.html`)) return `${p}/index.html`
    if (!p.split('/').pop()?.includes('.')) return isFile('200.html') ? '200.html' : null
    return isFile('404.html') ? '404.html' : null
  }
}

/** Every internal (same-origin) href/src in the given HTML file. */
function internalLinks(html, fileDir) {
  const refs = []
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const ref = m[1]
    if (ref.startsWith('#') || ref.startsWith('mailto:') || ref.startsWith('tel:')) continue
    if (/^[a-z]+:\/\//i.test(ref) || ref.startsWith('data:')) continue
    const abs = ref.startsWith('/') ? ref.slice(1) : resolvePath(fileDir, ref).slice(OUTPUT.length + 1)
    refs.push(abs.split(sep).join('/').replace(/^\/+/, ''))
  }
  return refs
}

function main() {
  if (!existsSync(join(OUTPUT, 'index.html'))) {
    fail(
      `no build output at ${OUTPUT} — run the app build first ` +
        '(root: pnpm build, or npx nuxi generate).',
    )
  }

  // 1) Write the Cloudflare Pages _headers (generated, never committed).
  const csp = productionCsp()
  writeFileSync(join(OUTPUT, '_headers'), buildHeadersFile(csp))
  console.log('[finalize] wrote _headers (CSP + security + cache rules)')

  const files = listFiles(OUTPUT)
  const resolve = makeResolver(files)
  let failures = 0
  const check = (label, ok, detail = '') => {
    if (!ok) failures++
    console.log(`[finalize] ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  }

  // 2) SPA shell + 404 documents.
  check('SPA shell index.html', files.includes('index.html'))
  check('clean-URL success doc 200.html (SPA fallback)', files.includes('200.html'))
  check('404 document', files.includes('404.html'))
  check('robots.txt', files.includes('robots.txt'))
  check('favicon', files.includes('favicon.svg'))

  // 3) Direct routes resolve to HTML (not 404).
  const slugs = readdirSync(resolvePath(here, '..', 'content', 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
  const routes = [
    '/', '/index.html', '/about', '/docs', '/explorer',
    ...slugs.map((s) => `/docs/${s}`),
  ]
  for (const route of routes) {
    const file = resolve(route)
    check(`route ${route}`, file !== null && file !== '404.html', `-> ${file ?? 'unresolved'}`)
  }

  // 4) Broken-link check over the GENERATED HTML.
  let linksChecked = 0
  for (const htmlFile of files.filter((f) => f.endsWith('.html'))) {
    const dir = dirname(htmlFile)
    for (const ref of internalLinks(readFileSync(join(OUTPUT, htmlFile), 'utf8'), dir)) {
      linksChecked++
      const file = resolve(`/${ref}`)
      if (file === null || file === '404.html') {
        check(`link in ${htmlFile} -> /${ref}`, false, 'does not resolve')
      }
    }
  }
  check(`internal links (generated HTML)`, failures === 0, `${linksChecked} checked`)

  // 5) Worker + jq WASM assets exist (the app is useless without them).
  const worker = files.find((f) => f.startsWith('_nuxt/') && /jsonl\.worker-[^/]+\.js$/.test(f))
  const wasm = files.find((f) => f.startsWith('_nuxt/') && /\.wasm$/.test(f))
  check('engine worker asset', worker !== undefined, worker ?? 'missing')
  check('jq WASM asset', wasm !== undefined, wasm ?? 'missing')

  // 6) 404 semantics: missing ASSETS are real 404s; unknown extensionless
  //    paths hit the SPA (200.html) and the app renders its own not-found.
  check('missing asset -> 404', resolve('/definitely-missing.png') === '404.html')
  check('unknown route -> SPA fallback', resolve('/definitely-missing-route') === '200.html')

  if (failures > 0) fail(`${failures} production-output check(s) failed`)
  console.log(`[finalize] production output OK (${files.length} files, ${routes.length} routes, ${linksChecked} links)`)
}

main()
