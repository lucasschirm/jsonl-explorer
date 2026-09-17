import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    // Serves jq-web's binary to the emscripten glue (TSK0027).
    setupFiles: [resolve(__dirname, 'tests/helpers/jqWasmShim.ts')],
    include: ['tests/unit/**/*.spec.ts'],
    alias: {
      '@': resolve(__dirname, '.'),
      '~': resolve(__dirname, '.'),
      '#app': resolve(__dirname, '.'),
      '#shared': resolve(__dirname, '../shared/src'),
    },
  },
})