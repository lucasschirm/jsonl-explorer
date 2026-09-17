<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useToastStore } from '~/stores/toasts'
import { useFileStore } from '~/stores/file'
import { useRouter } from 'vue-router'
import {
  decideHeaderRow,
  decideUrlInput,
  type HeaderRowIntake,
  type UrlIntake,
} from '~/utils/urlIntake'

interface HeaderEntry {
  key: string
  value: string
}

interface Props {
  open: boolean
  /** Non-secret URL to prefill on the first open (startup-recovery flow). */
  initialUrl?: string
}

interface Emits {
  (e: 'update:open', value: boolean): void
}

const props = withDefaults(defineProps<Props>(), { initialUrl: '' })
const emit = defineEmits<Emits>()

const router = useRouter()
const toastStore = useToastStore()
const fileStore = useFileStore()

const url = ref('')
const headers = ref<HeaderEntry[]>([{ key: '', value: '' }])
const isLoading = ref(false)
let hasPrefilled = false

/** Live URL validation (decideUrlInput is pure; see utils/urlIntake.ts). */
const urlIntake = computed<UrlIntake>(() => decideUrlInput(url.value))
const urlError = computed(() =>
  urlIntake.value.kind === 'invalid' ? urlIntake.value.message : '',
)
const isUrlValid = computed(() => urlIntake.value.kind === 'ready')

function addHeader() {
  headers.value.push({ key: '', value: '' })
}

function removeHeader(index: number) {
  if (headers.value.length <= 1) return
  headers.value.splice(index, 1)
}

/** Validates every header row (blank starter rows are skipped). */
const headerIntakes = computed<HeaderRowIntake[]>(() => {
  const seen = new Set<string>()
  return headers.value.map((h) => decideHeaderRow(h.key, h.value, seen))
})

const headerErrors = computed(() => {
  const errors: Record<number, string> = {}
  headerIntakes.value.forEach((intake, i) => {
    if (intake.kind === 'invalid') errors[i] = intake.message
  })
  return errors
})

const hasHeaderErrors = computed(() => Object.keys(headerErrors.value).length > 0)

/** True when any row looks like it carries credentials (warning only). */
const hasCredentialLikeHeader = computed(() =>
  headerIntakes.value.some((h) => h.kind === 'ready' && h.credentialLike),
)

/** Row-level mask: credential-like values are hidden by default. */
function isCredentialRow(index: number): boolean {
  const intake = headerIntakes.value[index]
  return intake?.kind === 'ready' && intake.credentialLike
}

/** The ready rows as fetch-ready [name, value] pairs. */
const readyHeaders = computed<[string, string][]>(() =>
  headerIntakes.value
    .filter((h): h is Extract<HeaderRowIntake, { kind: 'ready' }> => h.kind === 'ready')
    .map((h) => [h.name, h.value]),
)

async function onSubmit() {
  if (urlIntake.value.kind !== 'ready') return
  if (hasHeaderErrors.value) {
    toastStore.warning('Please fix header errors before proceeding', 'Invalid headers')
    return
  }

  isLoading.value = true
  try {
    // Normalized URL + validated headers go to the worker. Header values
    // (potentially credentials) are never logged, persisted, or echoed
    // into error messages.
    await fileStore.loadFromUrl(
      urlIntake.value.url,
      Object.fromEntries(readyHeaders.value),
    )
    emit('update:open', false)
    await router.push('/explorer')
  } catch (error) {
    // Recoverable failure: stay on landing with the entered URL so the
    // user can retry immediately (form is preserved, not reset).
    const message = error instanceof Error ? error.message : 'Failed to load from URL'
    toastStore.error(message, 'URL load failed')
  } finally {
    isLoading.value = false
  }
}

function onCancel() {
  emit('update:open', false)
  resetForm()
}

function resetForm() {
  url.value = ''
  headers.value = [{ key: '', value: '' }]
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      // First open: prefill a recovered URL (memory-only, via
      // useUrlRecovery) so a failed startup can be retried in place.
      if (!hasPrefilled && props.initialUrl !== '') {
        url.value = props.initialUrl
        hasPrefilled = true
      }
    } else {
      resetForm()
    }
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="modal modal-open" role="dialog" aria-modal="true" aria-labelledby="url-modal-title">
      <div class="modal-box max-w-2xl">
        <h3 id="url-modal-title" class="font-bold text-lg mb-4">Open JSONL from URL</h3>

        <!-- URL Input -->
        <div class="mb-4">
          <label class="label">
            <span class="label-text">URL (HTTP/HTTPS)</span>
          </label>
          <div class="relative">
            <input
              v-model="url"
              type="url"
              class="input input-bordered w-full pr-10"
              placeholder="https://example.com/data.jsonl"
              aria-describedby="url-error"
              :aria-invalid="!!urlError"
            />
            <div v-if="urlError" id="url-error" class="absolute right-3 top-1/2 -translate-y-1/2 text-error">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
          </div>
          <p v-if="urlError" class="label-text-alt text-error mt-1" role="alert">{{ urlError }}</p>
        </div>

        <!-- Headers -->
        <div class="mb-4">
          <div class="flex items-center justify-between mb-2">
            <label class="label cursor-pointer">
              <span class="label-text">Custom Headers (optional)</span>
            </label>
            <button
              type="button"
              @click="addHeader"
              class="btn btn-ghost btn-xs gap-1"
              aria-label="Add header"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
              Add
            </button>
          </div>

          <div class="space-y-2 max-h-60 overflow-y-auto">
            <div
              v-for="(header, index) in headers"
              :key="index"
              class="flex gap-2 items-start"
            >
              <input
                v-model="header.key"
                type="text"
                class="input input-bordered flex-1"
                placeholder="Header name (e.g., Authorization)"
                :aria-invalid="!!headerErrors[index]"
              />
              <input
                v-model="header.value"
                :type="isCredentialRow(index) ? 'password' : 'text'"
                class="input input-bordered flex-1"
                placeholder="Header value"
                :aria-invalid="!!headerErrors[index]"
              />
              <button
                type="button"
                @click="removeHeader(index)"
                :disabled="headers.length <= 1"
                class="btn btn-ghost btn-xs btn-circle text-error"
                aria-label="Remove header"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <div v-if="hasHeaderErrors" class="mt-2 text-sm text-error">
            <p class="font-medium">Header errors:</p>
            <ul class="list-disc list-inside mt-1 space-y-1">
              <li v-for="(err, idx) in headerErrors" :key="idx">Row {{ Number(idx) + 1 }}: {{ err }}</li>
            </ul>
          </div>

          <div v-if="hasCredentialLikeHeader" class="alert alert-warning gap-2 text-xs mt-2" role="alert">
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <strong>Credential notice:</strong> A header looks like it carries
              credentials (e.g. Authorization). It is sent only to the destination
              server and kept in memory only — never persisted, logged, or echoed
              in errors.
            </div>
          </div>

          <div class="alert alert-info gap-2 text-xs mt-2">
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <strong>Security note:</strong> Authorization and other sensitive
              headers are kept in memory only. They are never logged, sent to
              analytics, or included in error reports.
            </div>
          </div>
        </div>

        <!-- Actions -->
        <div class="modal-action">
          <button
            @click="onCancel"
            class="btn btn-ghost"
            :disabled="isLoading"
          >
            Cancel
          </button>
          <button
            @click="onSubmit"
            class="btn btn-primary"
            :disabled="isLoading || !isUrlValid || hasHeaderErrors"
          >
            <svg v-if="isLoading" class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {{ isLoading ? 'Loading...' : 'Open' }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop" @click="onCancel" />
    </div>
  </Teleport>
</template>
