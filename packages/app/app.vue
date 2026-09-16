<script setup lang="ts">
import { onMounted, watchEffect } from 'vue'
import { useTheme } from '~/composables/useTheme'
import Toaster from '~/components/ui/Toaster.vue'
import GlobalErrorHandler from '~/components/ui/GlobalErrorHandler.vue'

const { initTheme } = useTheme()

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
    <nuxt-page />
  </div>
</template>