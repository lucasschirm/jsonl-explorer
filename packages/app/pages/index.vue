<script setup lang="ts">
import FileDropZone from '~/components/landing/FileDropZone.vue'
import UrlOpenModal from '~/components/landing/UrlOpenModal.vue'
import { ref } from 'vue'

const showUrlModal = ref(false)
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4 bg-base-200">
    <div class="w-full max-w-2xl">
      <!-- Header -->
      <div class="text-center mb-8">
        <h1 class="text-4xl font-bold text-base-content mb-2">JSONL Explorer</h1>
        <p class="text-base-content/70">
          Open, explore, filter, edit and export multi-GB JSONL files — 100% in your browser.
        </p>
      </div>

      <!-- Main Card -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body p-6 space-y-6">
          <!-- File Drop Zone -->
          <FileDropZone />

          <div class="divider">or</div>

          <!-- URL Open Button -->
          <div class="text-center">
            <button
              @click="showUrlModal = true"
              class="btn btn-primary btn-lg gap-2"
              type="button"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              Open from URL
            </button>
            <p class="text-sm text-base-content/60 mt-2">
              Load JSONL from a public URL with optional custom headers
            </p>
          </div>

          <!-- Privacy Note -->
          <div class="alert alert-info gap-2 text-sm">
            <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <strong>Privacy:</strong> All processing happens 100% locally in your browser.
              No data is uploaded to any server.
            </div>
          </div>
        </div>
      </div>

      <!-- Footer links -->
      <div class="mt-6 flex justify-center gap-4 text-sm text-base-content/60">
        <nuxt-link to="/about" class="hover:underline">About</nuxt-link>
        <nuxt-link to="/docs" class="hover:underline">Documentation</nuxt-link>
        <a
          href="https://github.com/lucasschirm/jsonl-explorer"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:underline"
        >
          GitHub
        </a>
      </div>
    </div>

    <!-- URL Open Modal -->
    <UrlOpenModal v-model:open="showUrlModal" />
  </div>
</template>