<script setup lang="ts">
import { computed, ref } from 'vue'
import { queryContent, type ContentDocument } from '#imports'

// SPA mode (documentDriven: false): query the content API client-side.
// The content API serves BUILD-TIME-GENERATED query assets keyed by a
// hash of the query params — a where() containing the dynamic route
// slug has no stable hash and 404s. So this page runs the SAME static
// query as the docs index (whose asset exists) and picks its doc
// client-side. The computed `doc` tracks route changes, so client-side
// navigation between guides works without a reload.
const route = useRoute()
const all = ref<ContentDocument[]>([])
const doc = computed(() => {
  const slug = String(route.params.slug ?? '')
  // Content _path is '/docs/<slug>' (content lives under content/docs),
  // the route slug is '<slug>'.
  return all.value.find((d) => d._path === `/docs/${slug}`) ?? null
})
await load()

async function load(): Promise<void> {
  all.value = ((await queryContent().where({ _partial: false }).find()) ?? []) as ContentDocument[]
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Header -->
    <header class="navbar bg-base-100 border-b border-base-300 px-4">
      <div class="navbar-start">
        <span class="text-lg font-semibold text-base-content">JSONL Explorer</span>
      </div>
      <div class="navbar-end">
        <nuxt-link to="/docs" class="btn btn-ghost btn-sm">← All Guides</nuxt-link>
        <nuxt-link to="/" class="btn btn-ghost btn-sm">← Back to Explorer</nuxt-link>
      </div>
    </header>

    <!-- Main content -->
    <main class="flex-1 max-w-3xl mx-auto w-full p-6 space-y-8">
      <article v-if="doc" class="prose prose-base dark:prose-invert max-w-none">
        <h1 class="text-3xl font-bold text-base-content mb-4">{{ doc.title }}</h1>
        <p v-if="doc.description" class="text-lg text-base-content/70 mb-6">{{ doc.description }}</p>
        <ContentRenderer :value="doc" />
      </article>

      <div v-else class="text-center py-12 text-base-content/50">
        <svg class="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p class="text-lg">Guide not found</p>
        <p class="text-sm mt-1">The requested documentation page does not exist.</p>
        <nuxt-link to="/docs" class="btn btn-primary mt-4">Browse All Guides</nuxt-link>
      </div>
    </main>
  </div>
</template>