/**
 * TSK0051 — generate dependency credits from the pnpm lockfile + the
 * installed package metadata.
 *
 * What ships is what gets credited: the closure of the WORKSPACE packages'
 * declared `dependencies` (runtime edges only — devDependencies and peers
 * of build tooling never ship in the browser bundle or the zero-dependency
 * CLI). The closure is computed from `pnpm-lock.yaml` `snapshots`; the
 * name/version/license/repository metadata comes from the installed
 * `node_modules/.pnpm` package.json files (the lockfile itself carries no
 * license data).
 *
 * The license policy (`scripts/licensePolicy.mjs`) is the gate: a
 * dependency with missing, unknown, or forbidden license metadata — or
 * without a repository/homepage URL — FAILS the generation (exit 1).
 *
 * Output: `utils/credits.generated.json` (committed; CI regenerates and
 * diffs). Deterministic: sorted, no timestamps.
 *
 * Run: `pnpm --filter jsonl-explorer-app generate:credits`
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLicense } from './licensePolicy.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const repoRoot = join(appDir, '..', '..')
const LOCKFILE = join(repoRoot, 'pnpm-lock.yaml')
const PNPM_STORE = join(repoRoot, 'node_modules', '.pnpm')
// NOTE: must NOT live under content/ — Nuxt Content would index it as a
// guide document (queryContent() returns ALL content documents).
const OUT_FILE = join(appDir, 'utils', 'credits.generated.json')
/** Workspace importers whose runtime deps are credited (order = stable). */
const IMPORTERS = ['.', 'packages/app', 'packages/cli', 'packages/shared']

function fail(message) {
  console.error(`credits: ${message}`)
  process.exit(1)
}

/** Strip surrounding quotes from a YAML scalar. */
function unquote(value) {
  const v = value.trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * Split a `key: value` line at the FIRST colon (keys are package/snapshot
 * identifiers — none of the values in this file contain a bare `: `).
 */
function splitKeyValue(line) {
  const i = line.indexOf(':')
  if (i === -1) return null
  return { key: unquote(line.slice(0, i).trim()), value: unquote(line.slice(i + 1).trim()) }
}

/**
 * Parse the lockfile (line-based; the v9 format is regular).
 * Returns {
 *   importers: {path: {name: version}},          // runtime deps only
 *   snapshots: {key: [depSnapshotKeys]},         // runtime edges only
 *   packagePeers: {baseKey: Set<peerName>},      // for peer-skip
 * }.
 */
function parseLockfile(source) {
  const importers = {}
  const snapshots = {}
  const packagePeers = new Map()
  const optionalBases = new Set()
  let section = null // 'importers' | 'snapshots' | 'packages' | null
  let importer = null
  let depKind = null // 'dependencies' | 'devDependencies' | null
  let depName = null
  let snapshot = null
  let snapKind = null
  let pkgEntry = null // current base key in 'packages'
  let pkgKind = null // 'peerDependencies' | null
  const rawEdges = [] // { snapshot, name, value, optional }

  for (const raw of source.split('\n')) {
    if (raw.trim() === '') continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    const kv = splitKeyValue(line)

    if (indent === 0) {
      section = line === 'importers:' ? 'importers' : line === 'snapshots:' ? 'snapshots' : line === 'packages:' ? 'packages' : null
      importer = null; depKind = null; depName = null; snapshot = null; snapKind = null
      continue
    }
    if (section === 'importers') {
      if (indent === 2 && kv) {
        importer = kv.key; depKind = null; depName = null
        importers[importer] ??= {}
        continue
      }
      if (indent === 4 && kv && ['dependencies', 'devDependencies'].includes(kv.key)) {
        depKind = kv.key; depName = null
        continue
      }
      // Record RUNTIME deps only — devDependencies never ship.
      if (indent === 6 && kv && kv.value === '' && depKind === 'dependencies') {
        depName = kv.key
        importers[importer][depName] = { version: '' }
        continue
      }
      if (indent === 8 && kv && depName && kv.key === 'version') {
        importers[importer][depName].version = kv.value
        continue
      }
      continue
    }
    if (section === 'snapshots') {
      // A snapshot entry is `key:` (has children) or `key: {}` (leaf).
      if (indent === 2 && kv && (kv.value === '' || kv.value === '{}')) {
        snapshot = kv.key; snapKind = null
        if (!snapshots[snapshot]) snapshots[snapshot] = []
        continue
      }
      if (indent === 4 && kv && ['dependencies', 'optionalDependencies'].includes(kv.key)) {
        snapKind = kv.key
        continue
      }
      if (indent === 6 && kv && snapKind && snapshot) {
        // Values are bare versions (optionally with a peer suffix) — the
        // snapshot key is `name@<value>`. ALIASED deps are the exception
        // (the value is already a full `name@version`, e.g.
        // `string-width-cjs: string-width@4.2.3`); the ambiguity (peer
        // suffixes contain '@') is resolved against the known snapshot
        // keys after the parse. Store the raw pair for now.
        rawEdges.push({ snapshot, name: kv.key, value: kv.value, optional: snapKind === 'optionalDependencies' })
      }
      continue
    }
    if (section === 'packages') {
      if (indent === 2 && kv && (kv.value === '' || kv.value === '{}')) {
        pkgEntry = kv.key; pkgKind = null
        continue
      }
      if (indent === 4 && kv) {
        pkgKind = kv.key === 'peerDependencies' ? 'peerDependencies' : null
        continue
      }
      if (indent === 6 && kv && pkgKind === 'peerDependencies' && pkgEntry) {
        if (!packagePeers.has(pkgEntry)) packagePeers.set(pkgEntry, new Set())
        packagePeers.get(pkgEntry).add(kv.key)
      }
      continue
    }
  }
  // Resolve raw edges to snapshot keys now that every key is known.
  const allKeys = new Set(Object.keys(snapshots))
  for (const edge of rawEdges) {
    const plain = `${edge.name}@${edge.value}`
    const key = allKeys.has(plain) ? plain : edge.value // alias: value IS the key
    snapshots[edge.snapshot].push(key)
    if (edge.optional) {
      optionalBases.add(key.slice(0, key.indexOf('(') === -1 ? key.length : key.indexOf('(')))
    }
  }
  return { importers, snapshots, packagePeers, optionalBases }
}

/** `name@version(peers)` → { name, version } (version without peer suffix). */
function parseSnapshotKey(key) {
  const at = key.startsWith('@') ? key.indexOf('@', 1) : key.indexOf('@')
  const name = key.slice(0, at)
  const rest = key.slice(at + 1)
  const paren = rest.indexOf('(')
  return { name, version: (paren === -1 ? rest : rest.slice(0, paren)).trim() }
}

/** Resolve a `link:` target of an importer to a workspace importer path. */
function linkTarget(importerPath, version) {
  const rel = version.slice('link:'.length)
  const abs = resolve(join(repoRoot, importerPath), rel)
  const relToRoot = resolve(repoRoot, abs).slice(repoRoot.length + 1)
  return relToRoot === '' ? '.' : relToRoot
}

/** Runtime closure over the declared `dependencies` edges. */
function runtimeClosure(lock) {
  const closure = new Map() // base key `${name}@${version}` → snapshot key
  const visitedVariants = new Set() // snapshot keys already traversed
  const queue = []
  const enqueueImporter = (importerPath) => {
    for (const [name, { version }] of Object.entries(lock.importers[importerPath] ?? {})) {
      if (version.startsWith('link:')) {
        enqueueImporter(linkTarget(importerPath, version))
      } else {
        // Importer versions omit the name — the snapshot key is `name@<that>`.
        queue.push(`${name}@${version}`)
      }
    }
  }
  for (const importerPath of IMPORTERS) enqueueImporter(importerPath)

  while (queue.length > 0) {
    const key = queue.shift()
    // The same name@version can have several peer-resolution variants
    // (one snapshot key each); credit it ONCE but traverse every variant
    // (auto-installed peers can differ between variants).
    if (visitedVariants.has(key)) continue
    visitedVariants.add(key)
    const paren = key.indexOf('(')
    const base = paren === -1 ? key : key.slice(0, paren)
    closure.set(base, key)
    // AUTO-INSTALLED PEERS: with `autoInstallPeers: true`, pnpm records a
    // package's peer dependencies in the snapshot's `dependencies` (that is
    // how nuxt — a peer of @vueuse/nuxt — drags the whole build toolchain
    // into what looks like a runtime closure). Peers are satisfied by the
    // host app's own environment, not shipped by the depending package.
    const peerNames = lock.packagePeers.get(base) ?? new Set()
    for (const dep of lock.snapshots[key] ?? []) {
      const depBase = dep.slice(0, dep.indexOf('(') === -1 ? dep.length : dep.indexOf('('))
      const depName = parseSnapshotKey(depBase).name
      if (peerNames.has(depName)) continue
      queue.push(dep)
    }
  }
  return closure
}

/** Index installed packages: `${name}@${version}` → package.json path. */
function indexInstalledPackages() {
  const index = new Map()
  if (!existsSync(PNPM_STORE)) fail(`pnpm store not found at ${PNPM_STORE} — run pnpm install first`)
  for (const dir of readdirSync(PNPM_STORE)) {
    const at = dir.startsWith('@') ? dir.indexOf('@', 1) : dir.indexOf('@')
    if (at === -1) continue
    const name = dir.slice(0, at).replace(/\+/g, '/')
    const rest = dir.slice(at + 1)
    const us = rest.indexOf('_')
    const version = (us === -1 ? rest : rest.slice(0, us)).trim()
    const pkgPath = join(PNPM_STORE, dir, 'node_modules', name, 'package.json')
    if (!existsSync(pkgPath)) continue
    const key = `${name}@${version}`
    if (!index.has(key)) index.set(key, pkgPath)
  }
  return index
}

/** Read the package's license notice text, if a standard FILE exists. */
function licenseText(pkgDir) {
  for (const file of ['LICENSE', 'license', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT.txt', 'LICENSE-APACHE.txt', 'COPYING', 'UNLICENSE']) {
    const p = join(pkgDir, file)
    if (existsSync(p) && statSync(p).isFile()) {
      const text = readFileSync(p, 'utf8')
      return text.length > 32_000 ? text.slice(0, 32_000) : text
    }
  }
  return ''
}

function normalizeUrl(value) {
  if (!value) return ''
  let url = typeof value === 'string' ? value : value.url ?? value.href ?? ''
  // Canonicalize the git shorthand forms to https (the npm ecosystem uses
  // several: `git+https://`, `git://`, `ssh://git@`, `github:`).
  url = url.replace(/^git\+/, '')
  url = url.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
  url = url.replace(/^git:\/\/github\.com\//, 'https://github.com/')
  url = url.replace(/^github:\/\//, 'https://github.com/')
  url = url.replace(/^github:/, 'https://github.com/')
  // Bare `owner/repo` (the npm registry shorthand) → GitHub.
  if (/^[a-z0-9-_.]+\/[a-z0-9-_.]+$/i.test(url)) url = `https://github.com/${url}`
  return url.replace(/\.git$/, '')
}

async function main() {
  const lock = parseLockfile(readFileSync(LOCKFILE, 'utf8'))
  const closure = runtimeClosure(lock)
  const installed = indexInstalledPackages()

  const deps = []
  const errors = []
  for (const key of [...closure.keys()].sort()) {
    const { name, version } = parseSnapshotKey(key)
    const pkgPath = installed.get(`${name}@${version}`)
    if (!pkgPath) {
      // Optional (usually platform-specific) packages are only installed
      // for the current platform — not present here is expected.
      if (lock.optionalBases.has(key)) {
        console.log(`credits: skipped ${key} (optional, not installed for this platform)`)
        continue
      }
      errors.push(`${key}: not found in node_modules — run pnpm install and regenerate`)
      continue
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const audit = checkLicense(name, pkg.license)
    if (!audit.ok) {
      errors.push(audit.reason)
      continue
    }
    // Repository, then homepage, then the npm registry entry (which
    // always exists). Many small packages declare neither field — that is
    // NOT a license issue, so it is not a failure.
    let url = normalizeUrl(pkg.repository) || normalizeUrl(pkg.homepage)
    if (!url) {
      // Scoped packages use %2F in registry URLs.
      url = `https://www.npmjs.com/package/${name.replace('/', '%2F')}`
    } else if (!/^https?:\/\//.test(url)) {
      errors.push(`${key}: non-http(s) repository/homepage URL (${url})`)
      continue
    }
    deps.push({
      name,
      version,
      license: audit.license,
      url,
      licenseText: licenseText(dirname(pkgPath)),
    })
  }

  if (errors.length > 0) {
    console.error(`\ncredits: FAILED (${errors.length}):`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        note: 'GENERATED FILE — do not edit. Regenerate with `pnpm --filter jsonl-explorer-app generate:credits` (TSK0051).',
        deps,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`credits: ${deps.length} runtime dependencies → ${OUT_FILE}`)
}

void main()
