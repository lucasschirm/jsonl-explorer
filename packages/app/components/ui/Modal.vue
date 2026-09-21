<script setup lang="ts">
import { useModalBehavior } from '~/composables/useModalBehavior'

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

const close = () => {
  emit('update:modelValue', false)
}

// TSK0052: focus trap, Escape, scroll lock and focus restoration come
// from the shared modal behavior (also used by UrlOpenModal).
const { modalRef } = useModalBehavior(() => props.modelValue, close)

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
      ref="modalRef"
      class="modal modal-open"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="title ? 'modal-title' : undefined"
    >
      <div
        :class="['modal-box', sizeClasses[size || 'md']]"
      >
        <!-- div (not <header>): a <header> inside a non-sectioning div is
             a BANNER landmark — a modal must not add a second banner. -->
        <div v-if="title" class="flex items-center justify-between mb-4">
          <!-- h2: the page's h1 precedes it, so h2 keeps heading order. -->
          <h2 id="modal-title" class="font-bold text-lg">{{ title }}</h2>
          <button
            @click="close"
            class="btn btn-ghost btn-sm btn-circle"
            aria-label="Close"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <slot />
      </div>
      <div class="modal-backdrop" @click="close" />
    </div>
  </Teleport>
</template>