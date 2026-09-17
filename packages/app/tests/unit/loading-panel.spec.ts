/**
 * LoadingPanel component tests (TSK0019): separate download/index slots,
 * determinate vs indeterminate bars, incremental row counts, cancel.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LoadingPanel from '~/components/loading/LoadingPanel.vue'
import type { ProgressSlot } from '~/composables/useJsonlEngine'

const downloadSlot: ProgressSlot = { percent: 50, bytes: 1024, totalBytes: 2048, rows: null }
const indeterminateDownload: ProgressSlot = { percent: null, bytes: 4096, totalBytes: null, rows: null }
const indexSlot: ProgressSlot = { percent: 20, bytes: 4096, totalBytes: 20480, rows: 1234 }

describe('LoadingPanel', () => {
  it('shows no bars or actions when no slot is active', () => {
    const wrapper = mount(LoadingPanel, {
      props: { sourceName: 'a.jsonl', download: null, index: null },
    })
    expect(wrapper.find('progress').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('shows a determinate download bar with size and percent', () => {
    const wrapper = mount(LoadingPanel, {
      props: { sourceName: 'data.jsonl', download: downloadSlot, index: null },
    })
    const text = wrapper.text()
    expect(text).toContain('Downloading data.jsonl')
    expect(text).toContain('1.0 KiB / 2.0 KiB')
    expect(text).toContain('50%')
    const bar = wrapper.find('progress')
    expect(bar.attributes('value')).toBe('50')
    const region = wrapper.find('[role="progressbar"]')
    expect(region.attributes('aria-valuenow')).toBe('50')
  })

  it('shows an indeterminate bar when the total size is unknown', () => {
    const wrapper = mount(LoadingPanel, {
      props: { sourceName: 'data.jsonl', download: indeterminateDownload, index: null },
    })
    const text = wrapper.text()
    expect(text).toContain('4.0 KiB')
    expect(text).not.toContain('%')
    const bar = wrapper.find('progress')
    expect(bar.attributes('value')).toBeUndefined()
    expect(bar.classes()).toContain('progress-indeterminate')
  })

  it('shows the incremental row count for the index slot', () => {
    const wrapper = mount(LoadingPanel, {
      props: { sourceName: 'data.jsonl', download: null, index: indexSlot },
    })
    const text = wrapper.text()
    expect(text).toContain('Indexing')
    expect(text).toContain('1,234 rows')
    expect(text).toContain('20%')
  })

  it('renders both slots simultaneously (download + index)', () => {
    const wrapper = mount(LoadingPanel, {
      props: { sourceName: 'data.jsonl', download: downloadSlot, index: indexSlot },
    })
    expect(wrapper.text()).toContain('Downloading data.jsonl')
    expect(wrapper.text()).toContain('Indexing')
    expect(wrapper.findAll('progress').length).toBe(2)
  })

  it('shows the cancel button only when cancellable and emits cancel', async () => {
    const wrapper = mount(LoadingPanel, {
      props: { sourceName: 'a', download: downloadSlot, index: null, cancellable: false },
    })
    expect(wrapper.find('button[data-testid="loading-cancel"]').exists()).toBe(false)

    await wrapper.setProps({ cancellable: true })
    const button = wrapper.find('button[data-testid="loading-cancel"]')
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('announces itself as a live status region', () => {
    const wrapper = mount(LoadingPanel, {
      props: { sourceName: 'a', download: downloadSlot, index: null },
    })
    const region = wrapper.find('[role="status"]')
    expect(region.exists()).toBe(true)
    expect(region.attributes('aria-live')).toBe('polite')
  })
})
