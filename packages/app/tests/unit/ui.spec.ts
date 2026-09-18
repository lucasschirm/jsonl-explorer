import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import Modal from '~/components/ui/Modal.vue'
import ProgressBar from '~/components/ui/ProgressBar.vue'
import { useToastStore } from '~/stores/toasts'
import Toaster from '~/components/ui/Toaster.vue'
import { createPinia, setActivePinia } from 'pinia'

function findModalInBody() {
  return document.body.querySelector('.modal-box') as HTMLElement | null
}

function findModalBackdropInBody() {
  return document.body.querySelector('.modal-backdrop') as HTMLElement | null
}

function findCloseButtonInBody() {
  return document.body.querySelector('button[aria-label="Close"]') as HTMLElement | null
}

describe('Modal', () => {
  beforeEach(() => {
    // Clean up any existing modals
    document.body.querySelectorAll('.modal-open').forEach(el => el.remove())
  })

  it('renders when modelValue is true', () => {
    const wrapper = mount(Modal, {
      props: { modelValue: true, title: 'Test Modal' },
      attachTo: document.body,
    })

    const modalBox = findModalInBody()
    expect(modalBox).not.toBeNull()
    // h2 (TSK0052): the page h1 precedes the modal title in the heading
    // hierarchy — h3 skipped a level and failed axe heading-order.
    expect(modalBox?.querySelector('h2')?.textContent).toBe('Test Modal')
  })

  it('does not render when modelValue is false', () => {
    const wrapper = mount(Modal, {
      props: { modelValue: false },
      attachTo: document.body,
    })

    const modalBox = findModalInBody()
    expect(modalBox).toBeNull()
  })

  it('emits update:modelValue on close button click', async () => {
    const wrapper = mount(Modal, {
      props: { modelValue: true, title: 'Test Modal' },
      attachTo: document.body,
    })

    const closeBtn = findCloseButtonInBody()
    expect(closeBtn).not.toBeNull()
    closeBtn?.click()
    await vi.waitFor(() => expect(wrapper.emitted('update:modelValue')).toBeTruthy())
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('emits update:modelValue on backdrop click', async () => {
    const wrapper = mount(Modal, {
      props: { modelValue: true, title: 'Test Modal' },
      attachTo: document.body,
    })

    const backdrop = findModalBackdropInBody()
    expect(backdrop).not.toBeNull()
    backdrop?.click()
    await vi.waitFor(() => expect(wrapper.emitted('update:modelValue')).toBeTruthy())
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('emits update:modelValue on Escape key', async () => {
    const wrapper = mount(Modal, {
      props: { modelValue: true, title: 'Test Modal' },
      attachTo: document.body,
    })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await vi.waitFor(() => expect(wrapper.emitted('update:modelValue')).toBeTruthy())
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('traps focus with Tab key', async () => {
    const wrapper = mount(Modal, {
      props: { modelValue: true },
      attachTo: document.body,
      slots: {
        default: `
          <button class="first-btn">First</button>
          <button class="last-btn">Last</button>
        `,
      },
    })

    await vi.waitFor(() => {
      const firstBtn = document.body.querySelector('.first-btn') as HTMLElement
      const lastBtn = document.body.querySelector('.last-btn') as HTMLElement
      expect(firstBtn).not.toBeNull()
      expect(lastBtn).not.toBeNull()

      firstBtn?.focus()
      expect(document.activeElement).toBe(firstBtn)

      lastBtn?.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
      return document.activeElement === firstBtn
    })

    // Shift+Tab from first should wrap to last
    const firstBtn = document.body.querySelector('.first-btn') as HTMLElement
    const lastBtn = document.body.querySelector('.last-btn') as HTMLElement
    firstBtn?.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))
    await vi.waitFor(() => expect(document.activeElement).toBe(lastBtn))
  })

  it('restores focus on close', async () => {
    const trigger = document.createElement('button')
    trigger.id = 'trigger'
    document.body.appendChild(trigger)
    trigger.focus()

    const wrapper = mount(Modal, {
      props: { modelValue: true },
      attachTo: document.body,
    })

    const closeBtn = findCloseButtonInBody()
    closeBtn?.click()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))

    document.body.removeChild(trigger)
  })
})

describe('ProgressBar', () => {
  it('renders determinate progress', () => {
    const wrapper = mount(ProgressBar, {
      props: { value: 50, max: 100, label: 'Loading' },
    })

    expect(wrapper.find('progress').attributes('value')).toBe('50')
    expect(wrapper.find('progress').attributes('max')).toBe('100')
    expect(wrapper.text()).toContain('Loading')
    expect(wrapper.text()).toContain('50%')
  })

  it('renders indeterminate progress', () => {
    const wrapper = mount(ProgressBar, {
      props: { indeterminate: true, label: 'Loading...' },
    })

    expect(wrapper.find('progress').attributes('value')).toBeUndefined()
    expect(wrapper.find('progress').classes()).toContain('progress-indeterminate')
    expect(wrapper.text()).toContain('Loading...')
  })

  it('clamps value to max', () => {
    const wrapper = mount(ProgressBar, {
      props: { value: 150, max: 100 },
    })

    expect(wrapper.find('progress').attributes('max')).toBe('100')
  })

  it('clamps value to min', () => {
    const wrapper = mount(ProgressBar, {
      props: { value: -10, max: 100 },
    })

    expect(wrapper.find('progress').attributes('value')).toBe('-10')
  })

  it('hides percentage when showValue is false', () => {
    const wrapper = mount(ProgressBar, {
      props: { value: 50, showValue: false },
    })

    expect(wrapper.text()).not.toContain('50%')
  })
})

describe('Toast Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('adds and removes toasts', () => {
    const store = useToastStore()
    const id = store.add({ type: 'info', message: 'Test' })

    expect(store.toasts).toHaveLength(1)
    expect(store.toasts[0]!.message).toBe('Test')

    store.remove(id)
    expect(store.toasts).toHaveLength(0)
  })

  it('auto-dismisses after timeout', async () => {
    vi.useFakeTimers()
    const store = useToastStore()
    store.add({ type: 'info', message: 'Test', timeout: 1000 })

    expect(store.toasts).toHaveLength(1)

    vi.advanceTimersByTime(1000)
    await vi.waitFor(() => expect(store.toasts).toHaveLength(0))

    vi.useRealTimers()
  })

  it('does not auto-dismiss when timeout is 0', () => {
    vi.useFakeTimers()
    const store = useToastStore()
    store.add({ type: 'error', message: 'Test', timeout: 0 })

    vi.advanceTimersByTime(10000)
    expect(store.toasts).toHaveLength(1)

    vi.useRealTimers()
  })

  it('provides progress helper', () => {
    const store = useToastStore()
    const { id, update, done } = store.progress('Loading...')

    expect(store.toasts).toHaveLength(1)
    expect(store.toasts[0]!.progress).toBe(0)

    update(50)
    expect(store.toasts[0]!.progress).toBe(50)

    done(true)
    expect(store.toasts[0]!.progress).toBe(100)
    expect(store.toasts[0]!.type).toBe('success')
  })
})

describe('Toaster', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders toasts from store', () => {
    const store = useToastStore()
    store.add({ type: 'info', message: 'Test message' })

    const wrapper = mount(Toaster)

    expect(wrapper.text()).toContain('Test message')
  })

  it('shows different types with correct classes', () => {
    const store = useToastStore()
    store.add({ type: 'error', message: 'Error' })
    store.add({ type: 'success', message: 'Success' })
    store.add({ type: 'warning', message: 'Warning' })

    const wrapper = mount(Toaster)

    expect(wrapper.find('.alert-error').exists()).toBe(true)
    expect(wrapper.find('.alert-success').exists()).toBe(true)
    expect(wrapper.find('.alert-warning').exists()).toBe(true)
  })

  it('dismisses toast on button click', async () => {
    const store = useToastStore()
    const id = store.add({ type: 'info', message: 'Test' })

    const wrapper = mount(Toaster)
    await wrapper.find('button[aria-label="Dismiss"]').trigger('click')

    expect(store.toasts).toHaveLength(0)
  })

  it('shows progress bar when toast has progress', () => {
    const store = useToastStore()
    store.add({ type: 'info', message: 'Loading', progress: 50 })

    const wrapper = mount(Toaster)

    expect(wrapper.find('progress').exists()).toBe(true)
    expect(wrapper.find('progress').attributes('value')).toBe('50')
  })
})