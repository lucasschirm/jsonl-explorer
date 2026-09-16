<script setup lang="ts">
import { computed } from 'vue'
import { useToastStore } from '~/stores/toasts'

const toastStore = useToastStore()

const toasts = computed(() => toastStore.toasts)

function dismiss(id: string) {
  toastStore.remove(id)
}
</script>

<template>
  <div
    class="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
    aria-live="polite"
    aria-atomic="true"
  >
    <TransitionGroup name="toast" tag="div" class="flex flex-col gap-2">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto w-full max-w-sm animate-in slide-in-from-right duration-300"
      >
        <div
          :class="[
            'alert shadow-lg',
            toast.type === 'error' && 'alert-error',
            toast.type === 'warning' && 'alert-warning',
            toast.type === 'info' && 'alert-info',
            toast.type === 'success' && 'alert-success',
          ]"
          role="alert"
        >
          <div class="flex items-start gap-3">
            <div class="flex-1 min-w-0">
              <div v-if="toast.title" class="font-medium">{{ toast.title }}</div>
              <div class="text-sm opacity-90">{{ toast.message }}</div>
            </div>
            <button
              @click="dismiss(toast.id)"
              class="btn btn-ghost btn-xs btn-circle"
              aria-label="Dismiss"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div v-if="toast.progress !== undefined" class="mt-2">
            <progress class="progress progress-primary w-full" :value="toast.progress" max="100" />
          </div>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>