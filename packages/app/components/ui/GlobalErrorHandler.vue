<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useToastStore } from '~/stores/toasts'
import Modal from '~/components/ui/Modal.vue'

const toastStore = useToastStore()

const showErrorModal = ref(false)
const errorMessage = ref('')
const errorTitle = ref('')

function isClient(): boolean {
  return typeof window !== 'undefined'
}

onMounted(() => {
  if (isClient()) {
    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleRejection)
  }
})

onUnmounted(() => {
  if (isClient()) {
    window.removeEventListener('error', handleError)
    window.removeEventListener('unhandledrejection', handleRejection)
  }
})

function handleError(event: ErrorEvent) {
  // Ignore errors that are already handled (e.g., network errors from fetch)
  if (event.defaultPrevented) return

  const message = event.error?.message || event.message || 'Unknown error'
  const filename = event.filename || ''

  // Check if it's a worker error
  if (filename.includes('worker') || message.includes('worker')) {
    showFatalError('Worker Error', message)
  }
}

function handleRejection(event: PromiseRejectionEvent) {
  // Ignore if already handled
  if (event.defaultPrevented) return

  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason)

  // Check if it's a worker-related rejection
  if (message.includes('worker') || message.includes('Worker')) {
    showFatalError('Worker Error', message)
  }
}

function showFatalError(title: string, message: string) {
  errorTitle.value = title
  errorMessage.value = message
  showErrorModal.value = true

  // Also show as persistent toast
  toastStore.error(message, title, 0)
}

function reloadApp() {
  if (isClient()) {
    location.reload()
  }
}

function dismissError() {
  showErrorModal.value = false
}
</script>

<template>
  <div v-if="isClient()">
    <Modal v-model="showErrorModal" :title="errorTitle" size="lg">
      <div class="space-y-4">
        <div class="alert alert-error gap-3">
          <svg class="w-6 h-6 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <h4 class="font-bold">{{ errorTitle }}</h4>
            <p class="text-sm">{{ errorMessage }}</p>
          </div>
        </div>

        <p class="text-sm text-base-content/70">
          A fatal error occurred in the background worker. This usually means the worker crashed
          or ran out of memory. You can try reloading the page to restart the worker.
        </p>

        <div class="flex gap-2 justify-end">
          <button @click="dismissError" class="btn btn-ghost">Dismiss</button>
          <button @click="reloadApp" class="btn btn-primary">Reload Application</button>
        </div>
      </div>
    </Modal>
  </div>
</template>