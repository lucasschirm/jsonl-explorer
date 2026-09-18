/**
 * JsonTree / JsonNode (TSK0024): collapsible, theme-aware rendering of a
 * parsed JSON document. Collapse is independent per node and never
 * mutates the value; child counts show when collapsed; primitives get
 * token styling by type.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import JsonTree from '~/components/explorer/JsonTree.vue'
import type { JsonValue } from '~/utils/jsonTree'

const DOC: JsonValue = {
  name: 'jsonl',
  count: 3,
  tags: ['a', 'b', 'c'],
  nested: { on: true, off: null, pi: 3.14 },
}

function mountTree(value: JsonValue) {
  return mount(JsonTree, { props: { value } })
}

describe('JsonTree rendering', () => {
  // JsonNode resolves the detail store (inline editing, TSK0031):
  // provide an active pinia for the pure-rendering tests below.
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  it('renders keys, primitives, and containers', () => {
    const wrapper = mountTree(DOC)
    const text = wrapper.text()
    expect(text).toContain('name')
    expect(text).toContain('"jsonl"')
    expect(text).toContain('count')
    expect(text).toContain('3')
    expect(text).toContain('nested')
    expect(text).toContain('3.14')
  })

  it('styles primitive tokens by type (data-token)', () => {
    const wrapper = mountTree(DOC)
    const tokens = wrapper.findAll('[data-token]')
    const kinds = tokens.map((t) => t.attributes('data-token'))
    expect(kinds).toContain('string')
    expect(kinds).toContain('number')
    expect(kinds).toContain('boolean')
    expect(kinds).toContain('null')
    // Theme-aware classes: the --token-* variables (main.css) are chosen
    // to meet WCAG AA on both themes — stock daisyUI accent colors fail
    // contrast (TSK0052).
    const stringToken = tokens.find((t) => t.attributes('data-token') === 'string')!
    expect(stringToken.classes()).toContain('text-token-string')
    const numberToken = tokens.find((t) => t.attributes('data-token') === 'number')!
    expect(numberToken.classes()).toContain('text-token-number')
    const nullToken = tokens.find((t) => t.attributes('data-token') === 'null')!
    expect(nullToken.classes()).toContain('text-token-muted')
    expect(nullToken.classes()).toContain('italic')
  })

  it('collapses and expands a container independently, with a child count', async () => {
    const wrapper = mountTree({ list: [1, 2, 3], other: 'kept' })

    // Expanded by default: the array's numbers are in the DOM.
    expect(wrapper.findAll('[data-token="number"]').length).toBe(3)
    const toggle = wrapper.find('[data-testid="json-toggle-list-1"]')
    expect(toggle.exists()).toBe(true)

    // Collapse: children gone from the DOM, count summary shown.
    await toggle.trigger('click')
    expect(wrapper.findAll('[data-token="number"]').length).toBe(0)
    expect(wrapper.find('[data-testid="json-count-list-1"]').text()).toContain('3 items')

    // Expand again: children back.
    await toggle.trigger('click')
    expect(wrapper.findAll('[data-token="number"]').length).toBe(3)
    expect(wrapper.find('[data-testid="json-count-list-1"]').exists()).toBe(false)
  })

  it('large containers start collapsed (DOM guard)', () => {
    const big: JsonValue = Array.from({ length: 60 }, (_, i) => i)
    const wrapper = mountTree({ big })
    // 60 > COLLAPSE_ABOVE(50): collapsed on first render.
    expect(wrapper.find('[data-testid="json-count-big-1"]').text()).toContain('60 items')
  })

  it('shows the root primitive directly (no key)', () => {
    const wrapper = mountTree('just a string')
    expect(wrapper.text()).toBe('"just a string"')
    expect(wrapper.find('[data-testid^="json-toggle"]').exists()).toBe(false)
  })

  it('does not mutate the source value when collapsing', async () => {
    const doc: JsonValue = { a: [1, 2] }
    const wrapper = mountTree(doc)
    await wrapper.find('[data-testid="json-toggle-a-1"]').trigger('click')
    expect(doc).toEqual({ a: [1, 2] }) // untouched
  })
})
