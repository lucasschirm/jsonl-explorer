/**
 * Theme management composable
 * Uses browser's prefers-color-scheme for light/dark mode
 * No manual theme toggle - follows OS preference
 */

declare global {
  interface ImportMeta {
    client: boolean
  }
}

function isClient(): boolean {
  // In Nuxt/Vite, import.meta.client indicates client-side rendering
  // For testing, we can check if window is defined
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

export function useTheme(options?: { isClient?: boolean }) {
  let mediaQuery: MediaQueryList | null = null
  let listenerAttached = false

  const client = options?.isClient ?? isClient()

  function applyTheme(theme: 'light' | 'dark') {
    if (client) {
      document.documentElement.setAttribute('data-theme', theme)
    }
  }

  function initTheme() {
    if (client) {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      applyTheme(mediaQuery.matches ? 'dark' : 'light')

      if (!listenerAttached) {
        mediaQuery.addEventListener('change', handleChange)
        listenerAttached = true
      }
    }
  }

  function handleChange(event: MediaQueryListEvent) {
    applyTheme(event.matches ? 'dark' : 'light')
  }

  function cleanup() {
    if (mediaQuery && listenerAttached) {
      mediaQuery.removeEventListener('change', handleChange)
      listenerAttached = false
    }
  }

  return {
    initTheme,
    cleanup,
  }
}

/**
 * Returns current theme based on system preference
 */
export function getCurrentTheme(): 'light' | 'dark' {
  if (isClient()) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}