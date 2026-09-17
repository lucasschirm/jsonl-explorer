/**
 * FallbackConfirmModal component tests (TSK0019): the OPFS-fallback consent
 * dialog. The modal teleports to body, so DOM access is body-scoped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import FallbackConfirmModal from '~/components/loading/FallbackConfirmModal.vue'
import type { UrlFallbackConfirmRequest } from '@jsonl-explorer/shared'

function request(overrides: Partial<UrlFallbackConfirmRequest> = {}): UrlFallbackConfirmRequest {
  return {
    ns: 'jsonl-explorer',
    v: 1,
    type: 'urlFallbackConfirm',
    operationId: 'op-1',
    url: 'https://example.com/big.jsonl',
    reason: 'opfs-quota-exceeded',
    ...overrides,
  }
}

describe('FallbackConfirmModal', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
  })

  it('renders nothing when no request is pending', () => {
    wrapper = mount(FallbackConfirmModal, { props: { request: null } })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows the redacted URL, declared size, and the quota reason', () => {
    wrapper = mount(FallbackConfirmModal, {
      props: { request: request({ declaredBytes: 5368709120, reason: 'opfs-quota-exceeded' }) },
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Confirm memory fallback')
    expect(text).toContain('https://example.com/big.jsonl')
    expect(text).toContain('5.0 GiB')
    expect(text).toContain('quota was exceeded')
  })

  it('says "unknown" when no declared size is available', () => {
    wrapper = mount(FallbackConfirmModal, {
      props: { request: request({ declaredBytes: undefined, reason: 'opfs-unavailable' }) },
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Declared size: unknown')
    expect(text).toContain('not available in this browser')
  })

  it('explains the degraded limits of the memory fallback', () => {
    wrapper = mount(FallbackConfirmModal, { props: { request: request() } })
    const text = document.body.textContent ?? ''
    expect(text).toContain('in RAM')
    expect(text).toContain('lost when you close this tab')
  })

  it('emits decide(true) on accept and decide(false) on reject', async () => {
    wrapper = mount(FallbackConfirmModal, { props: { request: request() } })

    const accept = document.body.querySelector('button[data-testid="fallback-accept"]') as HTMLButtonElement
    const reject = document.body.querySelector('button[data-testid="fallback-reject"]') as HTMLButtonElement
    accept.click()
    expect(wrapper.emitted('decide')![0]).toEqual([true])

    reject.click()
    expect(wrapper.emitted('decide')![1]).toEqual([false])
  })
})
