/**
 * Docs frontmatter + internal link checker (TSK0048).
 *
 * Plain node, zero dependencies (CI-safe; runs before the app build).
 * Fails (exit 1) when:
 * - a guide under content/docs/ is missing `title` or `description`
 *   frontmatter (both required, non-empty);
 * - a markdown LINK or IMAGE target is broken:
 *     /docs/<slug>      → the slug file must exist;
 *     /, /explorer, /about, /docs → the known app routes;
 *     /screenshots/<f>  → the file must exist in public/screenshots/;
 *     other /…          → unknown app route (fail — no dead ends);
 *     relative          → the file must exist next to the guide;
 *     http(s)://, #…    → external / in-page (skipped).
 * Also prints every discovered guide slug (the static-route manifest the
 * e2e docs-routes suite deep-links against).
 *
 * Run: `node scripts/check-docs.mjs` (wired as `pnpm check:docs`).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DOCS = join(here, '..', 'content', 'docs')
const SHOTS_DIR = join(here, '..', 'public', 'screenshots')
const APP_ROUTES = new Set(['/', '/explorer', '/about', '/docs'])

const errors = []
const files = readdirSync(DOCS)
  .filter((f) => f.endsWith('.md'))
  .sort()

if (files.length === 0) errors.push(`no guides found under ${DOCS}`)

/** Parse `key: value` frontmatter between the first two `---` lines. */
function frontmatter(source, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source)
  if (!match) {
    errors.push(`${file}: missing frontmatter block (--- … ---)`)
    return {}
  }
  const out = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

/** Strip fenced code blocks so link-like text in code is not scanned. */
function stripFences(source) {
  return source.replace(/```[\s\S]*?```/g, '')
}

/** Extract [text](target) and ![alt](target) pairs. */
function linkTargets(source) {
  const targets = []
  const re = /(!?)\[[^\]]*\]\(([^)]+)\)/g
  let m
  while ((m = re.exec(source)) !== null) {
    // Strip an optional "title" from the target.
    let target = m[2].trim().replace(/\s+"[^"]*"\s*$/, '').replace(/\s+'[^']*'\s*$/, '')
    // Ignore pure-protocol or mailto-ish scheme links.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//')) continue
    targets.push({ image: m[1] === '!', target })
  }
  return targets
}

for (const file of files) {
  const source = readFileSync(join(DOCS, file), 'utf8')
  const slug = file.replace(/\.md$/, '')
  const fm = frontmatter(source, file)

  for (const field of ['title', 'description']) {
    if (!fm[field] || fm[field].length === 0) {
      errors.push(`${file}: frontmatter field \`${field}\` is missing or empty`)
    }
  }

  // The slug page renders the frontmatter title as the page's single H1;
  // a duplicate `# Title` in the body would create a second H1 (a11y +
  // ambiguous heading semantics).
  const h1 = /^# (?!#)(.+)$/m.exec(stripFences(source))
  if (h1 && fm.title && h1[1].trim() === fm.title.trim()) {
    errors.push(`${file}: body H1 duplicates the frontmatter title (remove the \`#\` line — the page renders the title)`)
  }

  const body = stripFences(source)
  for (const { image, target } of linkTargets(body)) {
    const kind = image ? 'image' : 'link'
    const noHash = target.split('#')[0]
    if (noHash === '') continue // in-page anchor

    if (noHash.startsWith('/docs/')) {
      const linkSlug = noHash.slice('/docs/'.length)
      if (!files.includes(`${linkSlug}.md`)) {
        errors.push(`${file}: broken ${kind} /docs/${linkSlug} (no such guide)`)
      }
    } else if (noHash.startsWith('/screenshots/')) {
      const shot = join(SHOTS_DIR, noHash.slice('/screenshots/'.length))
      if (!shot.startsWith(SHOTS_DIR) || !existsSync(shot)) {
        errors.push(`${file}: broken screenshot ${kind} ${noHash} (not in public/screenshots/)`)
      }
    } else if (noHash.startsWith('/')) {
      if (!APP_ROUTES.has(noHash)) {
        errors.push(`${file}: unknown app route ${kind} ${noHash}`)
      }
    } else {
      // Relative target: must exist next to the guide.
      const abs = resolve(DOCS, noHash)
      if (!abs.startsWith(resolve(DOCS))) {
        errors.push(`${file}: ${kind} escapes the docs directory: ${noHash}`)
      } else if (!existsSync(abs)) {
        errors.push(`${file}: broken ${kind} ${noHash} (file not found)`)
      }
    }
  }
}

console.log(`docs: ${files.length} guides — ${files.map((f) => `/docs/${f.replace(/\.md$/, '')}`).join(', ')}`)
if (errors.length > 0) {
  console.error(`\ncheck:docs FAILED (${errors.length}):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log('check:docs OK')
