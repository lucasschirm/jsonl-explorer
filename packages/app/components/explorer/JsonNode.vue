<script setup lang="ts">
/**
 * One node of the read-only JSON tree (TSK0024).
 *
 * Collapse/expand is LOCAL state (independent per node) and never mutates
 * the parsed value or the source row. Objects/arrays with many children
 * start collapsed so a large document cannot flood the DOM on first
 * render; the chevron always reveals the child count when collapsed.
 *
 * Token styling uses DaisyUI semantic colors (theme-aware CSS variables):
 * key=primary, string=success, number=warning, boolean=info, null=dimmed.
 */
import { computed, ref } from 'vue'
import type { JsonValue } from '~/utils/jsonTree'
import { isArray, childCount, isContainer, objectKeys } from '~/utils/jsonTree'

const props = withDefaults(
  defineProps<{
    value: JsonValue
    /** Parent object's key for this entry (null at the document root). */
    keyName?: string | null
    /** True when the entry is an ARRAY element (the key is its index,
     *  rendered dimmed instead of as an object key). */
    isArrayEntry?: boolean
    depth?: number
  }>(),
  { keyName: null, isArrayEntry: false, depth: 0 }
)

/** Containers with more children than this start collapsed. */
const COLLAPSE_ABOVE = 50

const expanded = ref(!isContainer(props.value) || childCount(props.value) <= COLLAPSE_ABOVE)

const isArr = computed(() => isArray(props.value))
const count = computed(() => childCount(props.value))
const keys = computed(() => objectKeys(props.value))
const entries = computed<Array<{ key: string; value: JsonValue }>>(() => {
  if (Array.isArray(props.value)) {
    return props.value.map((v, i) => ({ key: String(i), value: v }))
  }
  if (props.value !== null && typeof props.value === 'object') {
    return keys.value.map((k) => ({ key: k, value: (props.value as Record<string, JsonValue>)[k]! }))
  }
  return []
})

function tokenClass(value: JsonValue): string {
  if (value === null) return 'text-base-content/50 italic'
  switch (typeof value) {
    case 'string':
      return 'text-success'
    case 'number':
      return 'text-warning'
    case 'boolean':
      return 'text-info'
    default:
      return 'text-base-content'
  }
}

/** Primitives render their literal token (strings quoted, numbers as-is). */
function primitiveToken(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return `"${value}"`
  return String(value)
}
</script>

<template>
  <div :data-depth="depth">
    <div class="flex items-start gap-1 leading-6">
      <!-- Key / array index (not at the document root) -->
      <span
        v-if="keyName !== null"
        class="shrink-0 break-all"
        :class="isArrayEntry ? 'font-mono text-base-content/50' : 'font-medium text-primary'"
      >
        {{ keyName }}
        <span v-if="!isArrayEntry" class="text-base-content/50">:</span>
      </span>

      <!-- Container: chevron + open bracket, or a collapsed summary -->
      <template v-if="isContainer(value)">
        <button
          type="button"
          class="shrink-0 p-0.5 text-base-content/60 hover:text-base-content"
          :aria-expanded="expanded"
          :data-testid="`json-toggle-${keyName ?? 'root'}-${depth}`"
          @click="expanded = !expanded"
        >
          <svg
            class="w-3.5 h-3.5 transition-transform"
            :class="expanded ? 'rotate-90' : ''"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <span v-if="expanded" class="shrink-0 text-base-content/70">{{ isArr ? '[' : '{' }}</span>
        <span
          v-else
          class="shrink-0 text-base-content/60"
          :data-testid="`json-count-${keyName ?? 'root'}-${depth}`"
        >
          {{ isArr ? '[' : '{' }} {{ count }} item{{ count === 1 ? '' : 's' }}
          {{ isArr ? ']' : '}' }}
        </span>
      </template>

      <!-- Primitive: themed token -->
      <span v-else class="break-all" :class="tokenClass(value)" :data-token="typeof value === 'string' ? 'string' : value === null ? 'null' : String(typeof value)">
        {{ primitiveToken(value) }}
      </span>
    </div>

    <!-- Children (objects and arrays), each a node of its own -->
    <div v-if="isContainer(value) && expanded" class="pl-5 border-l border-base-300/60 ml-1.5">
      <JsonNode
        v-for="entry in entries"
        :key="entry.key"
        :value="entry.value"
        :key-name="entry.key"
        :is-array-entry="isArr"
        :depth="depth + 1"
      />
      <span class="block pl-5 text-base-content/70">{{ isArr ? ']' : '}' }}</span>
    </div>
  </div>
</template>
