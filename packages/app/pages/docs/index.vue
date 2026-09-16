<script setup lang="ts">
import { computed } from 'vue'
import { useContent } from '#imports'

const { data: docs } = await useContent().where({ _partial: false }).get()
const sortedDocs = computed(() => docs.value?.sort((a, b) => a.title.localeCompare(b.title)) ?? [])
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
      <section class="text-center space-y-4">
        <h1 class="text-4xl font-bold text-base-content">Documentation</h1>
        <p class="text-lg text-base-content/70 max-w-2xl mx-auto">
          Guides and reference for using JSONL Explorer effectively.
        </p>
      </section>

      <section>
        <h2 class="text-2xl font-semibold text-base-content mb-4">Guides</h2>
        <div class="grid gap-4 md:grid-cols-2">
          <nuxt-link
            v-for="doc in sortedDocs"
            :key="doc._path"
            :to="`/docs/${doc._path}`"
            class="card card-compact bg-base-200 hover:bg-base-300 transition-colors"
          >
            <div class="card-body">
              <h3 class="card-title text-base-content">{{ doc.title }}</h3>
              <p class="text-sm text-base-content/70">{{ doc.description }}</p>
            </div>
          </nuxt-link>
        </div>

        <div v-if="sortedDocs.length === 0" class="text-center py-12 text-base-content/50">
          <svg class="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p>No guides available yet. Add markdown files to <code>packages/app/content/docs/</code></p>
        </div>
      </section>
    </main>
  </div>
</template>