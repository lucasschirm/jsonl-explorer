<script setup lang="ts">
import { ref, useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'
import { useToastStore } from '~/stores/toasts'
import { useFileStore } from '~/stores/file'
import { decideDrop, decideFilePick, type FileIntake } from '~/utils/fileIntake'

const router = useRouter()
const toastStore = useToastStore()
const fileStore = useFileStore()

const dropZoneRef = useTemplateRef<HTMLDivElement>('dropZone')
const fileInputRef = useTemplateRef<HTMLInputElement>('fileInput')
const isDragging = ref(false)

const isLoading = ref(false)

/** Surfaces intake notices, then loads + navigates on success only. */
async function handleIntake(intake: FileIntake): Promise<void> {
  if (intake.kind === 'none') return

  if (intake.kind === 'reject-empty') {
    toastStore.warning(intake.notice.message, 'Zero-byte file')
    return
  }

  for (const notice of intake.notices) {
    toastStore.warning(notice.message, 'File note')
  }

  isLoading.value = true
  try {
    // Navigate only after the worker has the source set up (initFile
    // resolves with the worker's success response).
    await fileStore.loadFile(intake.file)
    await router.push('/explorer')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load file'
    toastStore.error(message, 'Load failed')
  } finally {
    isLoading.value = false
  }
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    void handleIntake(decideFilePick(input.files))
  }
  input.value = '' // Reset for same file re-selection
}

function onDragOver(event: DragEvent) {
  event.preventDefault()
  event.stopPropagation()
  isDragging.value = true
}

function onDragLeave(event: DragEvent) {
  event.preventDefault()
  event.stopPropagation()
  // Only clear if leaving the drop zone itself
  if (dropZoneRef.value && !dropZoneRef.value.contains(event.relatedTarget as Node)) {
    isDragging.value = false
  }
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  event.stopPropagation()
  isDragging.value = false

  const drop = decideDrop(event.dataTransfer?.items ?? null, event.dataTransfer?.files ?? null)
  if (drop.kind === 'directory') {
    toastStore.warning('Directories cannot be dropped — please pick a single file.', 'Directory dropped')
    return
  }
  if (drop.kind === 'non-file') {
    toastStore.warning('Only file drops are supported — plain text and links are ignored.', 'Non-file drop')
    return
  }
  void handleIntake(decideFilePick(drop.files))
}

function triggerFileInput() {
  fileInputRef.value?.click()
}
</script>

<template>
  <div
    ref="dropZone"
    class="relative border-2 border-dashed rounded-lg p-8 text-center transition-colors
           hover:border-primary/50 hover:bg-primary/5
           cursor-pointer"
    :class="[
      isDragging ? 'border-primary bg-primary/10' : 'border-base-300',
      isLoading ? 'opacity-50 pointer-events-none' : '',
    ]"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @click="triggerFileInput"
    role="button"
    tabindex="0"
    @keydown.enter="triggerFileInput"
    @keydown.space.prevent="triggerFileInput"
    aria-label="File drop zone. Click or drag and drop a JSONL file."
  >
    <input
      ref="fileInput"
      type="file"
      id="file-input"
      class="absolute inset-0 opacity-0 cursor-pointer"
      accept=".jsonl,.json,.ndjson,.txt,*/*"
      @change="onFileSelected"
      aria-hidden="true"
    />

    <div class="space-y-3">
      <svg
        class="w-12 h-12 mx-auto text-base-content/40"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.5"
          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
        />
      </svg>

      <div>
        <p class="text-lg font-medium text-base-content">
          Drop a JSONL file here or click to browse
        </p>
        <p class="text-sm text-base-content/60 mt-1">
          Supports .jsonl, .json, .ndjson, .txt (any text file)
        </p>
      </div>

      <div v-if="isDragging" class="text-primary font-medium animate-pulse">
        Drop file to load
      </div>

      <div v-if="isLoading" class="flex items-center justify-center gap-2 text-base-content/60">
        <svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span>Loading file...</span>
      </div>
    </div>
  </div>
</template>