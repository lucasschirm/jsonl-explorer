/**
 * Emits `jq.wasm.wasm` next to the worker chunk (TSK0027).
 *
 * The jq-web emscripten glue (`jq-web/jq.wasm.js`, bundled into its own
 * chunk) locates its binary relative to its own script url:
 * `scriptDirectory + 'jq.wasm.wasm'`. The chunks are emitted to `/_nuxt/`
 * in the Nuxt build, so the binary must be served at
 * `/_nuxt/jq.wasm.wasm` — a path Vite does not produce on its own.
 *
 *  - build: copies the package's binary into `<outDir>/_nuxt/` during
 *    generateBundle (fires whether or not Vite writes to disk);
 *  - dev:   serves the same path from the Vite dev server middleware.
 *
 * CSP already permits this (`wasm-unsafe-eval`, `connect-src 'self'`).
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Plugin, Rollup, ViteDevServer } from 'vite'

const NUXT_ASSET_DIR = '_nuxt'
const ASSET_NAME = 'jq.wasm.wasm'

export function jqWasmAssetPlugin(): Plugin {
  const req = createRequire(import.meta.url)
  const wasmSource = req.resolve(`jq-web/${ASSET_NAME}`)

  return {
    name: 'jsonl-explorer:jq-wasm-asset',
    apply: 'build',
    generateBundle(options: Rollup.OutputOptions) {
      if (!options?.dir) return
      const destDir = join(options.dir, NUXT_ASSET_DIR)
      mkdirSync(destDir, { recursive: true })
      copyFileSync(wasmSource, join(destDir, ASSET_NAME))
    },
    configureServer(server: ViteDevServer) {
      const url = `/${NUXT_ASSET_DIR}/${ASSET_NAME}`
      server.middlewares.use(url, (_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('Content-Type', 'application/wasm')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(readFileSync(wasmSource))
      })
    },
  }
}
