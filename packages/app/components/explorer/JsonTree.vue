<script setup lang="ts">
/**
 * Read-only JSON tree (TSK0024): renders a parsed JSON document as a
 * collapsible, theme-aware tree. The document is rendered as-is —
 * collapse state is per-node and local; nothing here mutates the value
 * or the source row.
 */
import type { JsonValue } from '~/utils/jsonTree'
import JsonNode from '~/components/explorer/JsonNode.vue'

/**
 * Optional local-search props (TSK0033): when the right-toolbar text
 * search is active, `matchKeys`/`currentKey` highlight the matching nodes
 * and `expandKeys` auto-expands the containers holding the current match.
 * Absent = plain read-only tree (no search state at all).
 */
withDefaults(
  defineProps<{
    value: JsonValue
    matchKeys?: Set<string>
    currentKey?: string | null
    expandKeys?: Set<string>
  }>(),
  { matchKeys: () => new Set<string>(), currentKey: null, expandKeys: () => new Set<string>() },
)
</script>

<template>
  <div class="font-mono text-sm overflow-auto" data-testid="json-tree">
    <JsonNode
      :value="value"
      :key-name="null"
      :depth="0"
      :match-keys="matchKeys"
      :current-key="currentKey"
      :expand-keys="expandKeys"
    />
  </div>
</template>
