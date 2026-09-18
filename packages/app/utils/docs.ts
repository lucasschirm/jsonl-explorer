/**
 * Docs domain helpers (TSK0048).
 *
 * Every guide under `content/docs/` carries the SAME typed frontmatter
 * (`title`, `description`) — the docs index, the slug page's prev/next
 * navigation, and the build-time link checker (`scripts/check-docs.mjs`)
 * all rely on this shape. The checker fails CI when a guide is missing
 * either field, so the types are not aspirational.
 */
/**
 * Structural view of a Nuxt Content v2 document. The `#imports` alias is
 * NOT resolvable from plain .ts files under `tsc --noEmit` (it only exists
 * as a Nuxt-generated virtual module for the runtime/auto-imports), so the
 * pages cast their `ContentDocument`s to this shape instead.
 */
export interface ContentDocBase {
  _path: string
  [key: string]: unknown
}

/** Required frontmatter for every guide. */
export interface Doc {
  title: string
  description: string
}

export type DocsDocument = ContentDocBase & Doc

/** The route (and content) path for a guide slug: `/docs/<slug>`. */
export function docPath(slug: string): string {
  return `/docs/${slug}`
}

/** Guides in navigation order — the order the index displays them in. */
export function docOrder(docs: readonly DocsDocument[]): DocsDocument[] {
  return [...docs].sort((a, b) => a.title.localeCompare(b.title))
}
