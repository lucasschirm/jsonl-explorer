<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  value?: number
  max?: number
  indeterminate?: boolean
  label?: string
  showValue?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  max: 100,
  indeterminate: false,
  showValue: true,
})

const percentage = computed(() => {
  if (props.indeterminate || props.value === undefined) return undefined
  return Math.min(100, Math.max(0, (props.value / props.max) * 100))
})

const ariaValueText = computed(() => {
  if (props.indeterminate) return 'Loading...'
  if (props.value === undefined) return undefined
  return `${Math.round(percentage.value!)}%`
})
</script>

<template>
  <div class="w-full" role="progressbar" :aria-valuenow="value" :aria-valuemin="0" :aria-valuemax="max" :aria-valuetext="ariaValueText">
    <div v-if="label" class="flex items-center justify-between mb-1">
      <span class="text-sm font-medium text-base-content">{{ label }}</span>
      <span v-if="showValue && !indeterminate && value !== undefined" class="text-sm text-base-content/70 font-mono">
        {{ Math.round(percentage!) }}%
      </span>
      <span v-if="showValue && indeterminate" class="text-sm text-base-content/70">
        Loading...
      </span>
    </div>
    <progress
      :value="indeterminate ? undefined : value"
      :max="max"
      class="progress progress-primary w-full h-2"
      :class="{ 'progress-indeterminate': indeterminate }"
    />
    <div v-if="indeterminate" class="absolute -top-2 left-0 right-0 h-2 animate-pulse bg-primary/30" />
  </div>
</template>