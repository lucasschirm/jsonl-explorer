<script setup lang="ts">
/**
 * Read-only JSON tree (TSK0024): renders a parsed JSON document as a
 * collapsible, theme-aware tree. The document is rendered as-is —
 * collapse state is per-node and local; nothing here mutates the value
 * or the source row.
 */
import type { JsonValue } from '~/utils/jsonTree'
import JsonNode from '~/components/explorer/JsonNode.vue'

defineProps<{ value: JsonValue }>()
</script>

<template>
  <div class="font-mono text-sm overflow-auto" data-testid="json-tree">
    <JsonNode :value="value" :key-name="null" :depth="0" />
  </div>
</template>
