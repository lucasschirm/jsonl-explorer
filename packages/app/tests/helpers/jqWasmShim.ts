/**
 * Test shim for the jq-web WASM build (TSK0027).
 *
 * `jq-web/jq.wasm.js` (emscripten glue) loads its binary by fetching
 * `scriptDirectory + 'jq.wasm.wasm'` relative to wherever the glue runs.
 * Under vitest there is no HTTP server that can serve the package's
 * binary, so this shim intercepts `fetch` for ANY url ending in
 * `jq.wasm.wasm` and responds with the real bytes from node_modules,
 * carrying the `application/wasm` MIME type that
 * `WebAssembly.instantiateStreaming` requires. The shim also removes
 * `WebAssembly.instantiateStreaming` from the test realm: Node's WebAssembly
 * rejects happy-dom Response objects (cross-realm), and the glue's
 * ArrayBuffer fallback — which the shim serves — is deterministic.
 *
 * All other fetches pass through untouched. Production is unaffected:
 * the worker fetches `/_nuxt/jq.wasm.wasm`, copied next to the worker
 * chunk by nuxt.config.ts.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

let installed = false

export function installJqWasmFetchShim(): void {
  if (installed) return
  installed = true
  const req = createRequire(import.meta.url)
  const bytes = readFileSync(req.resolve('jq-web/jq.wasm.wasm'))
  const realFetch = globalThis.fetch
  // Force the glue's ArrayBuffer path (see header) instead of a streaming
  // attempt that would fail with a cross-realm Response.
  delete (WebAssembly as unknown as { instantiateStreaming?: unknown }).instantiateStreaming

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (url.endsWith('jq.wasm.wasm')) {
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/wasm' },
      })
    }
    if (typeof realFetch !== 'function') {
      throw new Error('no fetch implementation available for non-jq urls')
    }
    return realFetch(input, init)
  }) as typeof fetch
}

// Installed by vitest setupFiles; the guard makes repeated imports safe.
installJqWasmFetchShim()
