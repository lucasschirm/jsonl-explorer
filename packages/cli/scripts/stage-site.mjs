/**
 * Stages the app's static build into packages/cli/site (TSK0040).
 *
 * The published CLI bundles the explorer site so `jsonlex --local` works
 * from an installed tarball without any workspace present. The source of
 * truth is packages/app/.output/public (the SPA build; the nitro node
 * server is NOT shipped — the CLI's own Fastify server plays that role).
 *
 * Usage: node scripts/stage-site.mjs   (run from packages/cli)
 * The target is replaced atomically-enough for a build step: clean, copy,
 * verify the index.html marker.
 */
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cliRoot = join(here, '..')
const source = join(cliRoot, '..', 'app', '.output', 'public')
const target = join(cliRoot, 'site')

function fail(message) {
  console.error(`[stage-site] ${message}`)
  process.exit(1)
}

if (!existsSync(join(source, 'index.html'))) {
  fail(
    `app build output not found at ${source} — run the app build first ` +
      '(root: pnpm build builds app before cli).',
  )
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })

// Cloudflare Pages' `_headers` (written by the app's production finalize
// step, TSK0054) is host-specific config — the CLI's own Fastify server
// sets its own headers, and the file must not be served at /_headers.
rmSync(join(target, '_headers'), { force: true })

// Sanity: the SPA entry must have survived the copy.
if (!existsSync(join(target, 'index.html'))) {
  fail(`index.html missing after copy to ${target}`)
}

const entries = readdirSync(target).length
console.log(`[stage-site] staged ${entries} entries from app build into ${target}`)
