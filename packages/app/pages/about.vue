<script setup lang="ts">
import { onMounted, ref } from 'vue'

const deps = ref<Array<{ name: string; version: string; license: string; repository?: string }>>([])
const loading = ref(true)

onMounted(async () => {
  try {
    // In a real app, this would be generated at build time
    // For now, we'll show a placeholder
    deps.value = [
      { name: 'nuxt', version: '3.11.x', license: 'MIT', repository: 'https://github.com/nuxt/nuxt' },
      { name: 'vue', version: '3.4.x', license: 'MIT', repository: 'https://github.com/vuejs/core' },
      { name: 'pinia', version: '2.1.x', license: 'MIT', repository: 'https://github.com/vuejs/pinia' },
      { name: 'tailwindcss', version: '4.x', license: 'MIT', repository: 'https://github.com/tailwindlabs/tailwindcss' },
      { name: 'daisyui', version: '5.x', license: 'MIT', repository: 'https://github.com/saadeghi/daisyui' },
      { name: '@tanstack/vue-virtual', version: '3.3.x', license: 'MIT', repository: 'https://github.com/TanStack/virtual' },
      { name: 'jq-web', version: '0.5.x', license: 'MIT', repository: 'https://github.com/jq-web/jq-web' },
      { name: 'lucide-vue-next', version: '0.350.x', license: 'ISC', repository: 'https://github.com/lucide-icons/lucide' },
      { name: 'fastify', version: '4.26.x', license: 'MIT', repository: 'https://github.com/fastify/fastify' },
      { name: '@fastify/static', version: '7.0.x', license: 'MIT', repository: 'https://github.com/fastify/fastify-static' },
      { name: 'open', version: '10.0.x', license: 'MIT', repository: 'https://github.com/sindresorhus/open' },
    ]
  } catch (error) {
    console.error('Failed to load dependencies:', error)
  } finally {
    loading.value = false
  }
})


</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Header -->
    <header class="navbar bg-base-100 border-b border-base-300 px-4">
      <div class="navbar-start">
        <span class="text-lg font-semibold text-base-content">JSONL Explorer</span>
      </div>
      <div class="navbar-end">
        <nuxt-link to="/" class="btn btn-ghost btn-sm">← Back to Explorer</nuxt-link>
      </div>
    </header>

    <!-- Main content -->
    <main class="flex-1 max-w-4xl mx-auto w-full p-6 space-y-8">
      <!-- Hero -->
      <section class="text-center space-y-4">
        <h1 class="text-4xl font-bold text-base-content">About JSONL Explorer</h1>
        <p class="text-lg text-base-content/70 max-w-2xl mx-auto">
          A 100% client-side web application for exploring, filtering, editing, and exporting
          multi-GB JSONL files directly in your browser. No backend required — all processing
          happens locally using Web Workers and modern browser APIs.
        </p>
      </section>

      <!-- Key Features -->
      <section>
        <h2 class="text-2xl font-semibold text-base-content mb-4">Key Features</h2>
        <ul class="space-y-3">
          <li class="flex items-start gap-3 p-4 bg-base-200 rounded-lg">
            <svg class="w-6 h-6 text-primary shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <strong class="text-base-content">Multi-GB Support</strong>
              <p class="text-sm text-base-content/70">Stream and index files without loading entirely into memory using Web Workers</p>
            </div>
          </li>
          <li class="flex items-start gap-3 p-4 bg-base-200 rounded-lg">
            <svg class="w-6 h-6 text-primary shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <div>
              <strong class="text-base-content">Powerful Filtering</strong>
              <p class="text-sm text-base-content/70">Text search and jq queries with progress and cancellation</p>
            </div>
          </li>
          <li class="flex items-start gap-3 p-4 bg-base-200 rounded-lg">
            <svg class="w-6 h-6 text-primary shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            <div>
              <strong class="text-base-content">JSON Editing</strong>
              <p class="text-sm text-base-content/70">Inline value editing with type coercion, export with edits preserved</p>
            </div>
          </li>
          <li class="flex items-start gap-3 p-4 bg-base-200 rounded-lg">
            <svg class="w-6 h-6 text-primary shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <div>
              <strong class="text-base-content">100% Client-Side</strong>
              <p class="text-sm text-base-content/70">No data upload, no backend, works offline after initial load</p>
            </div>
          </li>
          <li class="flex items-start gap-3 p-4 bg-base-200 rounded-lg">
            <svg class="w-6 h-6 text-primary shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            <div>
              <strong class="text-base-content">URL Loading</strong>
              <p class="text-sm text-base-content/70">Fetch from HTTP/HTTPS with custom headers, OPFS-backed streaming</p>
            </div>
          </li>
          <li class="flex items-start gap-3 p-4 bg-base-200 rounded-lg">
            <svg class="w-6 h-6 text-primary shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            <div>
              <strong class="text-base-content">Embedding & Handover</strong>
              <p class="text-sm text-base-content/70">postMessage API for iframe/window.open integration</p>
            </div>
          </li>
        </ul>
      </section>

      <!-- Privacy -->
      <section>
        <h2 class="text-2xl font-semibold text-base-content mb-4">Privacy</h2>
        <div class="alert alert-info gap-2">
          <svg class="w-6 h-6 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <strong>Your data stays in your browser.</strong> JSONL Explorer processes all files locally using
            Web Workers. No file content is ever sent to any server. URL-loaded files are fetched directly
            from the source to your browser.
          </div>
        </div>
      </section>

      <!-- Open Source Credits -->
      <section>
        <h2 class="text-2xl font-semibold text-base-content mb-4">Open Source Credits</h2>
        <p class="text-sm text-base-content/70 mb-4">
          This project is built on the shoulders of giants. Below are the key dependencies and their licenses.
          Full dependency tree with transitive dependencies is available in the
          <a href="https://github.com/lucasschirm/jsonl-explorer" target="_blank" rel="noopener noreferrer" class="link link-primary">GitHub repository</a>.
        </p>

        <div v-if="loading" class="flex justify-center py-8">
          <svg class="animate-spin w-8 h-8 text-primary" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>

        <div v-else class="overflow-x-auto">
          <table class="table table-zebra w-full">
            <thead>
              <tr>
                <th>Package</th>
                <th>Version</th>
                <th>License</th>
                <th>Repository</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="dep in deps" :key="dep.name">
                <td class="font-mono">{{ dep.name }}</td>
                <td>{{ dep.version }}</td>
                <td><span class="badge badge-outline">{{ dep.license }}</span></td>
                <td>
                  <a :href="dep.repository" target="_blank" rel="noopener noreferrer" class="link link-primary">
                    {{ dep.repository }}
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mt-4 p-4 bg-base-200 rounded-lg text-sm text-base-content/70">
          <strong>License:</strong> MIT License — see
          <a href="https://github.com/lucasschirm/jsonl-explorer/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" class="link link-primary">
            LICENSE
          </a>
          for details.
        </div>
      </section>

      <!-- Links -->
      <section class="pt-4 border-t border-base-300">
        <div class="flex flex-wrap gap-4 justify-center">
          <a href="https://github.com/lucasschirm/jsonl-explorer" target="_blank" rel="noopener noreferrer" class="btn btn-ghost gap-2">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            GitHub
          </a>
          <a href="https://jsonlexplorer.lucasschirm.com" target="_blank" rel="noopener noreferrer" class="btn btn-ghost gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            Live Demo
          </a>
          <a href="https://www.npmjs.com/package/jsonlex" target="_blank" rel="noopener noreferrer" class="btn btn-ghost gap-2">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.521 17.34l-1.342-.329V11.93c0-.904-.329-1.591-.905-2.026l-3.836.082L8.772 7.018v2.012H5.915V6.6l4.217.573V12l-3.546.724v3.23l1.773-.165 2.569 3.323 2.836-3.557.33 3.192z"/></svg>
            npm Package
          </a>
        </div>
      </section>
    </main>
  </div>
</template>