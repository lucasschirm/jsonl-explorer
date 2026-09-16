import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface Toast {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  title?: string
  message: string
  progress?: number
  timeout?: number
}

export const useToastStore = defineStore('toasts', () => {
  const toasts = ref<Toast[]>([])

  function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }

  function add(toast: Omit<Toast, 'id'>): string {
    const id = generateId()
    const newToast: Toast = { ...toast, id }
    toasts.value.push(newToast)

    if (toast.timeout !== 0) {
      const delay = toast.timeout ?? 5000
      setTimeout(() => remove(id), delay)
    }

    return id
  }

  function remove(id: string) {
    const index = toasts.value.findIndex((t) => t.id === id)
    if (index !== -1) {
      toasts.value.splice(index, 1)
    }
  }

  function clear() {
    toasts.value = []
  }

  function info(message: string, title?: string, timeout?: number) {
    return add({ type: 'info', message, title, timeout })
  }

  function success(message: string, title?: string, timeout?: number) {
    return add({ type: 'success', message, title, timeout })
  }

  function warning(message: string, title?: string, timeout?: number) {
    return add({ type: 'warning', message, title, timeout })
  }

  function error(message: string, title?: string, timeout?: number) {
    return add({ type: 'error', message, title, timeout: timeout ?? 0 })
  }

  function progress(message: string, title?: string): { id: string; update: (progress: number) => void; done: (success?: boolean) => void } {
    const id = add({ type: 'info', message, title, progress: 0, timeout: 0 })

    return {
      id,
      update: (progress: number) => {
        const toast = toasts.value.find((t) => t.id === id)
        if (toast) toast.progress = Math.max(0, Math.min(100, progress))
      },
      done: (success = true) => {
        const toast = toasts.value.find((t) => t.id === id)
        if (toast) {
          toast.progress = 100
          toast.type = success ? 'success' : 'error'
          toast.timeout = 3000
          setTimeout(() => remove(id), 3000)
        }
      },
    }
  }

  return {
    toasts: computed(() => toasts.value),
    add,
    remove,
    clear,
    info,
    success,
    warning,
    error,
    progress,
  }
})