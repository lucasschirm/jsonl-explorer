<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useToastStore } from '~/stores/toasts'
import { useFileStore } from '~/stores/file'
import { useRouter } from 'vue-router'

interface HeaderEntry {
  key: string
  value: string
}

interface Props {
  open: boolean
}

interface Emits {
  (e: 'update:open', value: boolean): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const router = useRouter()
const toastStore = useToastStore()
const fileStore = useFileStore()

const url = ref('')
const headers = ref<HeaderEntry[]>([{ key: '', value: '' }])
const isLoading = ref(false)
const urlError = ref('')

// Forbidden header names (browser-forbidden)
const forbiddenHeaders = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
])

function validateUrl(input: string): boolean {
  try {
    const u = new URL(input)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      urlError.value = 'Only HTTP/HTTPS URLs are allowed'
      return false
    }
    // Reject URLs with credentials
    if (u.username || u.password) {
      urlError.value = 'URLs with embedded credentials are not allowed'
      return false
    }
    // Reject URLs with fragments
    if (u.hash) {
      urlError.value = 'URL fragments are not allowed'
      return false
    }
    urlError.value = ''
    return true
  } catch {
    urlError.value = 'Invalid URL format'
    return false
  }
}

function validateHeader(key: string, value: string): string | null {
  const lowerKey = key.toLowerCase().trim()
  if (!lowerKey) return 'Header name cannot be empty'
  if (forbiddenHeaders.has(lowerKey)) return `Header "${key}" is forbidden by the browser`
  if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) return 'Header cannot contain line breaks'
  if (key.length > 256) return 'Header name too long (max 256 chars)'
  if (value.length > 4096) return 'Header value too long (max 4096 chars)'
  return null
}

function addHeader() {
  headers.value.push({ key: '', value: '' })
}

function removeHeader(index: number) {
  if (headers.value.length <= 1) return
  headers.value.splice(index, 1)
}

const headerErrors = computed(() => {
  const errors: Record<number, string> = {}
  const seen = new Set<string>()
  headers.value.forEach((h, i) => {
    const key = h.key.trim().toLowerCase()
    if (key && seen.has(key)) {
      errors[i] = `Duplicate header: ${h.key}`
    }
    seen.add(key)
    const err = validateHeader(h.key, h.value)
    if (err) errors[i] = err
  })
  return errors
})

const hasHeaderErrors = computed(() => Object.keys(headerErrors.value).length > 0)

const validHeaders = computed(() =>
  headers.value
    .filter((h) => h.key.trim() && !headerErrors.value[headers.value.indexOf(h)])
    .map((h) => [h.key.trim(), h.value.trim()] as [string, string])
)

async function onSubmit() {
  if (!validateUrl(url.value)) return
  if (hasHeaderErrors.value) {
    toastStore.warning('Please fix header errors before proceeding', 'Invalid headers')
    return
  }

  isLoading.value = true
  try {
    await fileStore.loadFromUrl(url.value, Object.fromEntries(validHeaders.value))
    emit('update:open', false)
    await router.push('/explorer')
  } catch (error) {
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
  urlError.value = ''
}

watch(
  () => props.open,
  (open) => {
    if (!open) resetForm()
  }
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
              @blur="validateUrl(url)"
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
                @input="$forceUpdate()"
              />
              <input
                v-model="header.value"
                type="text"
                class="input input-bordered flex-1"
                placeholder="Header value"
                :aria-invalid="!!headerErrors[index]"
                @input="$forceUpdate()"
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

          <div class="alert alert-warning gap-2 text-xs mt-2">
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <strong>Security note:</strong> Authorization and other sensitive headers are kept in memory only.
              They are never logged, sent to analytics, or included in error reports.
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
            :disabled="isLoading || !validateUrl(url) || hasHeaderErrors"
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