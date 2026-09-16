<script setup lang="ts">
import { onMounted, onUnmounted, watch, nextTick, ref } from 'vue'

interface Props {
  modelValue: boolean
  title?: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const modalRef = ref<HTMLDivElement | null>(null)

let previousActiveElement: HTMLElement | null = null

const close = () => {
  emit('update:modelValue', false)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    close()
  }
  // Trap focus within modal
  if (event.key === 'Tab') {
    const focusableElements = modalRef.value?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    if (!focusableElements || focusableElements.length === 0) return

    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      lastElement.focus()
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      firstElement.focus()
    }
  }
}

onMounted(() => {
  if (props.modelValue) {
    previousActiveElement = document.activeElement as HTMLElement
    document.addEventListener('keydown', handleKeydown)
    document.body.style.overflow = 'hidden'
    nextTick(() => {
      const firstFocusable = modalRef.value?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      firstFocusable?.focus()
    })
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.body.style.overflow = ''
})

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      previousActiveElement = document.activeElement as HTMLElement
      document.addEventListener('keydown', handleKeydown)
      document.body.style.overflow = 'hidden'
      nextTick(() => {
        const firstFocusable = modalRef.value?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        firstFocusable?.focus()
      })
    } else {
      document.removeEventListener('keydown', handleKeydown)
      document.body.style.overflow = ''
      previousActiveElement?.focus()
    }
  }
)

const sizeClasses = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-5xl',
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="modal modal-open"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="title ? 'modal-title' : undefined"
    >
      <div
        ref="modalRef"
        :class="['modal-box', sizeClasses[size || 'md']]"
      >
        <header v-if="title" class="flex items-center justify-between mb-4">
          <h3 id="modal-title" class="font-bold text-lg">{{ title }}</h3>
          <button
            @click="close"
            class="btn btn-ghost btn-sm btn-circle"
            aria-label="Close"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>
        <slot />
      </div>
      <div class="modal-backdrop" @click="close" />
    </div>
  </Teleport>
</template>