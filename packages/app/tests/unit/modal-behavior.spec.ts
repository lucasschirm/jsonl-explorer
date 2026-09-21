/**
 * TSK0052 — unit tests for the shared modal a11y behavior
 * (composables/useModalBehavior.ts): initial focus, focus trap,
 * Escape-to-close, scroll lock, focus restoration, stacked-dialog
 * topmost rule, and the canEscape guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick, defineComponent, h } from 'vue'
import { useModalBehavior } from '~/composables/useModalBehavior'

interface HostOptions {
  canEscape?: () => boolean
  /** When true, the Escape handler closes the dialog (app semantics). */
  autoClose?: boolean
}

/**
 * Minimal host: a role=dialog div (the modalRef target) with two
 * focusable buttons, open/close state driven from outside.
 */
/** The modalRef Ref's type, for closure capture in render functions. */
type ModalRef = ReturnType<typeof useModalBehavior>['modalRef']

function makeHost(escapeSpy: () => void, options: HostOptions = {}) {
  // The Ref is captured in a closure: a render function cannot use
  // `this.modalRef` (the proxy unwraps it to the raw value, and Vue's
  // vnode `ref` prop needs the Ref object itself).
  let modalRef: ModalRef | undefined
  const open = ref(true)
  return defineComponent({
    setup() {
      const { modalRef: mr } = useModalBehavior(
        () => open.value,
        () => {
          escapeSpy()
          if (options.autoClose !== false) open.value = false
        },
        options.canEscape !== undefined ? { canEscape: options.canEscape } : {},
      )
      modalRef = mr
      return {}
    },
    render() {
      if (!open.value) return null
      return h(
        'div',
        { ref: modalRef, role: 'dialog', 'aria-modal': 'true' },
        [h('button', { id: 'first' }, 'first'), h('button', { id: 'second' }, 'second')],
      )
    },
  })
}

async function mountHost(escapeSpy: () => void, options: HostOptions = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(makeHost(escapeSpy, options), { attachTo: host })
  await nextTick()
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('first'))
  return { wrapper, host }
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

describe('useModalBehavior (TSK0052)', () => {
  let spy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    spy = vi.fn()
    document.body.querySelectorAll('[role="dialog"]').forEach((el) => el.remove())
    // setProperty with a concrete value: see the composable's note on the
    // happy-dom inline-style quirk (clearing + re-assigning corrupts the
    // style object in this test environment).
    document.body.style.setProperty('overflow', 'visible')
  })

  afterEach(() => {
    document.body.style.setProperty('overflow', 'visible')
    vi.restoreAllMocks()
  })

  it('focuses the first focusable element when opening', async () => {
    const { wrapper } = await mountHost(spy)
    expect(document.activeElement?.id).toBe('first')
    wrapper.unmount()
  })

  it('closes on Escape and restores focus to the previously active element', async () => {
    const trigger = document.createElement('button')
    trigger.id = 'trigger'
    document.body.appendChild(trigger)
    trigger.focus()

    await mountHost(spy)
    expect(document.activeElement?.id).toBe('first')

    pressEscape()
    expect(spy).toHaveBeenCalledTimes(1)
    // auto-close: the dialog unmounts and focus returns to the trigger.
    await vi.waitFor(() =>
      expect(document.body.querySelector('[role="dialog"]')).toBeNull(),
    )
    expect(document.activeElement?.id).toBe('trigger')
  })

  it('traps Tab at the last element and Shift+Tab at the first', async () => {
    const { wrapper } = await mountHost(spy)

    const second = document.getElementById('second') as HTMLButtonElement
    second.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('first')

    const first = document.getElementById('first') as HTMLButtonElement
    first.focus()
    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    document.dispatchEvent(shiftTab)
    expect(shiftTab.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('second')
    wrapper.unmount()
  })

  it('locks body scroll while open and releases it when closed', async () => {
    expect(document.body.style.overflow).toBe('visible')
    const { wrapper } = await mountHost(spy)
    expect(document.body.style.overflow).toBe('hidden')
    wrapper.unmount()
    // Restored to the pre-open value (visible):
    expect(document.body.style.overflow).toBe('visible')
  })

  it('ignores Escape while canEscape() is false, then honors it', async () => {
    const { wrapper } = await mountHost(spy, { canEscape: () => false })
    pressEscape()
    expect(spy).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    wrapper.unmount()

    const second = await mountHost(spy, { canEscape: () => true })
    pressEscape()
    expect(spy).toHaveBeenCalledTimes(1)
    second.wrapper.unmount()
  })

  it('only the topmost stacked dialog reacts to Escape', async () => {
    const lower = await mountHost(spy)

    // A second, stacked dialog (mounted later → later in DOM order):
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    let upperModalRef: ModalRef | undefined
    const upperOpen = ref(true)
    const upper = defineComponent({
      setup() {
        const { modalRef: mr } = useModalBehavior(() => upperOpen.value, () => {
          spy()
          upperOpen.value = false
        })
        upperModalRef = mr
        return {}
      },
      render() {
        if (!upperOpen.value) return null
        return h('div', { ref: upperModalRef, role: 'dialog' }, [
          h('button', { id: 'upper-btn' }, 'upper'),
        ])
      },
    })
    const upperWrapper = mount(upper, { attachTo: host2 })
    await nextTick()

    pressEscape()
    await nextTick() // let the upper dialog's re-render flush
    // Only the UPPER dialog closed:
    expect(spy).toHaveBeenCalledTimes(1)
    expect(document.getElementById('upper-btn')).toBeNull()
    expect(lower.wrapper.element).toBeTruthy()

    // With the upper one gone, the lower dialog owns Escape again:
    pressEscape()
    await nextTick()
    expect(spy).toHaveBeenCalledTimes(2)

    upperWrapper.unmount()
    lower.wrapper.unmount()
  })
})
