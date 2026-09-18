/**
 * TSK0048 — docs domain helpers.
 */
import { describe, it, expect } from 'vitest'
import { docOrder, docPath } from '../../utils/docs'
import type { DocsDocument } from '../../utils/docs'

function doc(title: string, slug: string): DocsDocument {
  return { _path: `/docs/${slug}`, title, description: `${title} guide` } as DocsDocument
}

describe('utils/docs', () => {
  it('docPath maps a slug to its /docs route', () => {
    expect(docPath('getting-started')).toBe('/docs/getting-started')
  })

  it('docOrder sorts by title (locale order) and does not mutate', () => {
    const a = doc('Editing and Export', 'editing-and-export')
    const b = doc('Getting Started', 'getting-started')
    const c = doc('CLI', 'cli')
    const input = [b, a, c]
    const ordered = docOrder(input)
    expect(ordered.map((d) => d.title)).toEqual(['CLI', 'Editing and Export', 'Getting Started'])
    expect(input.map((d) => d.title)).toEqual(['Getting Started', 'Editing and Export', 'CLI'])
  })
})
