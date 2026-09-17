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
 *
 * Editing (TSK0031): every value (primitive OR container) can be edited
 * inline — clicking the value token opens the store's edit session for
 * this node's path; Enter/blur commits (JSON.parse coercion, whole
 * document re-serialized compactly, one setEdit), Escape cancels. The
 * chevron stays purely expand/collapse.
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { JsonValue } from '~/utils/jsonTree'
import { isArray, childCount, isContainer, objectKeys } from '~/utils/jsonTree'
import type { EditPath } from '~/utils/jsonEdit'
import { pathKey as toPathKey } from '~/utils/detailSearch'
import { useDetailStore } from '~/stores/detail'

const props = withDefaults(
  defineProps<{
    value: JsonValue
    /** Parent object's key for this entry (null at the document root). */
    keyName?: string | null
    /** True when the entry is an ARRAY element (the key is its index,
     *  rendered dimmed instead of as an object key). */
    isArrayEntry?: boolean
    depth?: number
    /** Path from the document root to THIS node (parents only). */
    path?: EditPath
    /** Local-search (TSK0033): path keys of all current text matches. */
    matchKeys?: Set<string>
    /** Local-search: path key of the match navigation points at. */
    currentKey?: string | null
    /** Local-search: ancestor keys to auto-expand for the current match. */
    expandKeys?: Set<string>
  }>(),
  {
    keyName: null,
    isArrayEntry: false,
    depth: 0,
    path: () => [],
    matchKeys: () => new Set<string>(),
    currentKey: null,
    expandKeys: () => new Set<string>(),
  },
)

const detailStore = useDetailStore()

/** Full path of this node (its own key/index appended to the parents').
 *  Array entries contribute a NUMBER segment (path application matches
 *  array indices numerically); object entries keep their string key. */
const nodePath = computed<EditPath>(() => {
  if (props.keyName === null) return []
  const segment = props.isArrayEntry ? Number(props.keyName) : props.keyName
  return [...props.path, segment]
})

/** Local-search highlighting (TSK0033): this node's path identity. */
const selfKey = computed(() => toPathKey(nodePath.value))
const isMatch = computed(() => props.matchKeys.has(selfKey.value))
const isCurrent = computed(() => props.currentKey !== null && props.currentKey === selfKey.value)

/** Scroll the current match into view once navigation moves to it. */
const rowEl = ref<HTMLElement | null>(null)
watch(isCurrent, (now) => {
  if (!now) return
  void nextTick(() => rowEl.value?.scrollIntoView({ block: 'nearest' }))
})

/** True while this node is the one in the inline editor. */
const isEditingHere = computed(() => {
  const editing = detailStore.editingPath
  if (editing === null) return false
  if (editing.length !== nodePath.value.length) return false
  return editing.every((segment, i) => segment === nodePath.value[i])
})

/** Focus the editor input once it has mounted (click-to-edit UX). */
const editInput = ref<HTMLInputElement | null>(null)
function focusEditInput(): void {
  void nextTick(() => {
    editInput.value?.focus()
    editInput.value?.select()
  })
}

/** Click-to-edit: primitives on the token, containers on the bracket or
 *  the collapsed summary (the chevron is reserved for expand/collapse). */
function beginEdit(): void {
  if (detailStore.isEditing) return // one editor at a time
  detailStore.startEdit(nodePath.value)
  if (isEditingHere.value) focusEditInput()
}

/** Containers with more children than this start collapsed. */
const COLLAPSE_ABOVE = 50

const expanded = ref(
  !isContainer(props.value) ||
    childCount(props.value) <= COLLAPSE_ABOVE ||
    props.expandKeys.has(selfKey.value),
)
/** Search navigation may point INSIDE a collapsed container: open it.
 *  (One-way: the user can still collapse it again afterwards. */
watch(
  () => props.expandKeys,
  (keys) => {
    if (keys.has(selfKey.value)) expanded.value = true
  },
)

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
  <div :data-depth="depth" ref="rowEl">
    <div class="flex items-start gap-1 leading-6">
      <!-- Key / array index (not at the document root). Local search
           (TSK0033) highlights matching keys/values and the current one. -->
      <span
        v-if="keyName !== null"
        class="shrink-0 break-all"
        :class="[
          isArrayEntry ? 'font-mono text-base-content/50' : 'font-medium text-primary',
          isMatch ? 'bg-warning/30 rounded-sm' : '',
          isCurrent ? 'bg-warning/60 rounded-sm' : '',
        ]"
      >
        {{ keyName }}
        <span v-if="!isArrayEntry" class="text-base-content/50">:</span>
      </span>

      <!-- Inline editor (TSK0031): replaces the value token while editing.
           Enter/blur commit (coerce + whole-document setEdit), Escape cancels. -->
      <input
        v-if="isEditingHere"
        :ref="(el) => (editInput = el as HTMLInputElement | null)"
        v-model="detailStore.editDraft"
        type="text"
        spellcheck="false"
        autocomplete="off"
        class="input input-xs font-mono w-48 max-w-full shrink"
        :aria-label="`Edit value ${keyName ?? 'root'}`"
        data-testid="json-edit-input"
        @keydown.enter.prevent="detailStore.commitEdit()"
        @keydown.esc.prevent="detailStore.cancelEdit()"
        @blur="detailStore.commitEdit()"
      />

      <!-- Container: chevron + open bracket, or a collapsed summary.
           The chevron toggles; the bracket/summary starts the edit. -->
      <template v-else-if="isContainer(value)">
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
        <button
          v-if="expanded"
          type="button"
          class="shrink-0 p-0 bg-transparent text-base-content/70 cursor-text hover:text-base-content"
          :data-testid="`json-edit-${keyName ?? 'root'}-${depth}`"
          title="Edit this value"
          @click="beginEdit()"
        >
          {{ isArr ? '[' : '{' }}
        </button>
        <button
          v-else
          type="button"
          class="shrink-0 p-0 bg-transparent text-base-content/60 cursor-text hover:text-base-content"
          :data-testid="`json-count-${keyName ?? 'root'}-${depth}`"
          title="Edit this value"
          @click="beginEdit()"
        >
          {{ isArr ? '[' : '{' }} {{ count }} item{{ count === 1 ? '' : 's' }}
          {{ isArr ? ']' : '}' }}
        </button>
      </template>

      <!-- Primitive: themed, editable token (click to edit) -->
      <button
        v-else
        type="button"
        class="break-all p-0 bg-transparent text-left cursor-text hover:underline decoration-dotted underline-offset-2"
        :class="[
          tokenClass(value),
          isMatch ? 'bg-warning/30 rounded-sm' : '',
          isCurrent ? 'bg-warning/60 rounded-sm' : '',
        ]"
        :data-token="typeof value === 'string' ? 'string' : value === null ? 'null' : String(typeof value)"
        :data-testid="`json-edit-${keyName ?? 'root'}-${depth}`"
        title="Edit this value"
        @click="beginEdit()"
      >
        {{ primitiveToken(value) }}
      </button>
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
        :path="nodePath"
        :match-keys="matchKeys"
        :current-key="currentKey"
        :expand-keys="expandKeys"
      />
      <span class="block pl-5 text-base-content/70">{{ isArr ? ']' : '}' }}</span>
    </div>
  </div>
</template>
