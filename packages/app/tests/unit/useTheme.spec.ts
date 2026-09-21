/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { useTheme, getCurrentTheme } from '../../composables/useTheme'

describe('useTheme', () => {
  let matchMediaMock: Mock
  let addEventListenerMock: Mock
  let removeEventListenerMock: Mock
  let originalMatchMedia: typeof window.matchMedia

  beforeEach(() => {
    addEventListenerMock = vi.fn()
    removeEventListenerMock = vi.fn()
    matchMediaMock = vi.fn(() => ({
      matches: false,
      addEventListener: addEventListenerMock,
      removeEventListener: removeEventListenerMock,
    }))

    originalMatchMedia = window.matchMedia
    window.matchMedia = matchMediaMock

    // Reset document attribute
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    vi.clearAllMocks()
  })

  it('applies light theme when prefers-color-scheme is light', () => {
    matchMediaMock.mockImplementation(() => ({
      matches: false,
      addEventListener: addEventListenerMock,
      removeEventListener: removeEventListenerMock,
    }))

    const { initTheme, cleanup } = useTheme()
    initTheme()

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(addEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function))

    cleanup()
    expect(removeEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('applies dark theme when prefers-color-scheme is dark', () => {
    matchMediaMock.mockImplementation(() => ({
      matches: true,
      addEventListener: addEventListenerMock,
      removeEventListener: removeEventListenerMock,
    }))

    const { initTheme, cleanup } = useTheme()
    initTheme()

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(addEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function))

    cleanup()
    expect(removeEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('handles live theme change from light to dark', () => {
    let changeHandler: (event: MediaQueryListEvent) => void

    matchMediaMock.mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn((_, handler) => {
        changeHandler = handler
      }),
      removeEventListener: removeEventListenerMock,
    }))

    const { initTheme, cleanup } = useTheme()
    initTheme()

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    // Simulate OS theme change
    changeHandler!({ matches: true } as MediaQueryListEvent)

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    cleanup()
    expect(removeEventListenerMock).toHaveBeenCalled()
  })

  it('handles live theme change from dark to light', () => {
    let changeHandler: (event: MediaQueryListEvent) => void

    matchMediaMock.mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn((_, handler) => {
        changeHandler = handler
      }),
      removeEventListener: removeEventListenerMock,
    }))

    const { initTheme, cleanup } = useTheme()
    initTheme()

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    // Simulate OS theme change
    changeHandler!({ matches: false } as MediaQueryListEvent)

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    cleanup()
    expect(removeEventListenerMock).toHaveBeenCalled()
  })

  it('cleanup removes event listener', () => {
    matchMediaMock.mockImplementation(() => ({
      matches: false,
      addEventListener: addEventListenerMock,
      removeEventListener: removeEventListenerMock,
    }))

    const { initTheme, cleanup } = useTheme()
    initTheme()
    cleanup()

    expect(removeEventListenerMock).toHaveBeenCalledTimes(1)
    expect(removeEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('getCurrentTheme returns correct theme', () => {
    matchMediaMock.mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))

    expect(getCurrentTheme()).toBe('dark')

    matchMediaMock.mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))

    expect(getCurrentTheme()).toBe('light')
  })

  it('does not throw when window is undefined (SSR)', () => {
    const originalWindow = global.window
    // @ts-expect-error - deleting window for test
    delete global.window

    expect(() => getCurrentTheme()).not.toThrow()
    expect(getCurrentTheme()).toBe('light')

    global.window = originalWindow
  })
})