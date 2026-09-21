<script setup lang="ts">
import { computed, onMounted, watchEffect } from 'vue'
import { useTheme } from '~/composables/useTheme'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import Toaster from '~/components/ui/Toaster.vue'
import GlobalErrorHandler from '~/components/ui/GlobalErrorHandler.vue'
import FallbackConfirmModal from '~/components/loading/FallbackConfirmModal.vue'

const { initTheme } = useTheme()
const engine = useJsonlEngine()
// Refs inside plain objects are not auto-unwrapped in templates.
const fallbackRequest = computed(() => engine.fallbackRequest.value)

onMounted(() => {
  initTheme()
})

watchEffect(() => {
  // Theme is handled by useTheme composable
})
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <Toaster />
    <GlobalErrorHandler />
    <!-- Global consent dialog: the worker pauses a URL download while the
         OPFS-fallback decision is pending (TSK0019). -->
    <FallbackConfirmModal :request="fallbackRequest" @decide="engine.confirmUrlFallback" />
    <nuxt-page />
  </div>
</template>
