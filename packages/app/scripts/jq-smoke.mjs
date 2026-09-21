/**
 * Production-build smoke for the jq WASM backend (TSK0027).
 *
 * Runs the EXACT built worker chunk (.output/public/_nuxt/jsonl.worker-*.js)
 * in a Node module worker, with minimal browser-worker globals shimmed
 * (importScripts/location/fetch-for-the-wasm) so the emscripten glue takes
 * the same code path it takes in a real browser worker:
 * `ENVIRONMENT_IS_WORKER -> scriptDirectory from location.href -> fetch
 * (scriptDirectory + 'jq.wasm.wasm') -> WebAssembly.instantiateStreaming`.
 *
 * It then drives the real RPC protocol: initMemory -> index -> jq filters
 * (including the 64-bit-return path `.i % 2 == 0` that kills the asm.js
 * bundle) and a compile-error filter. Exits 0 only if every check passes.
 *
 * Usage: pnpm build && node scripts/jq-smoke.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const here = dirname(fileURLToPath(import.meta.url))
const nuxtDir = join(here, '..', '.output', 'public', '_nuxt')

const files = readdirSync(nuxtDir)
const workerChunk = files.find((f) => f.startsWith('jsonl.worker-') && f.endsWith('.js'))
if (!workerChunk) {
  console.error('FAIL: no jsonl.worker-*.js in .output/public/_nuxt (run pnpm build first)')
  process.exit(1)
}
const wasmBytes = readFileSync(join(nuxtDir, 'jq.wasm.wasm'))

// Browser-worker globals the emscripten glue expects. The fetch shim serves
// the real build-output wasm bytes for the same-origin url the glue builds
// from the (shimmed) script location.
const shim = `
  // parentPort is NOT a global in Node worker threads - import it so the
  // onmessage bridge below can post into the built worker unchanged.
  import { parentPort } from 'node:worker_threads'

  globalThis.self = globalThis
  globalThis.importScripts = () => {}
  // Node workers have no DOM event API; the emscripten glue only registers
  // listeners it never expects to fire in this smoke.
  globalThis.addEventListener = () => {}
  globalThis.removeEventListener = () => {}
  // The built worker posts responses with self.postMessage (browser global);
  // route it to the Node parentPort.
  globalThis.postMessage = (data) => parentPort.postMessage(data)
  // Node has no web-style onmessage global: bridge it to the imported
  // parentPort so the built worker bootstrap (assigning self.onmessage)
  // works unchanged.
  Object.defineProperty(globalThis, 'onmessage', {
    set(handler) {
      parentPort.on('message', (data) => handler({ data }))
    },
    configurable: true,
  })
  globalThis.location = { href: 'http://localhost/_nuxt/${workerChunk}' }
  // The emscripten glue awaits fetch() (returns a Promise in browsers and
  // Node/undici), so the shim must return a Promise<Response>, not a Response.
  const realFetch = fetch
  globalThis.fetch = (url) => {
    const u = String(url)
    if (u.endsWith('jq.wasm.wasm')) {
      return Promise.resolve(
        new Response(Buffer.from('${wasmBytes.toString('base64')}', 'base64'), {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        }),
      )
    }
    return realFetch(url)
  }
`

const worker = new Worker(join(nuxtDir, workerChunk), {
  type: 'module',
  execArgv: ['--import', `data:text/javascript;base64,${Buffer.from(shim).toString('base64')}`],
})

const ROWS = []
for (let i = 0; i < 3000; i++) ROWS.push(`{"i":${i},"tag":"${i % 3 === 0 ? 'x' : 'y'}"}`)
ROWS.push('')
const payload = ROWS.map((r) => r + '\n').join('')

const events = []
const pending = new Map()
let workerError = null

worker.on('error', (error) => {
  workerError = error
})

worker.on('message', (msg) => {
  if (msg?.requestId !== undefined) {
    const waiters = pending.get(msg.requestId) ?? []
    pending.set(msg.requestId, [])
    for (const w of waiters) w(msg)
  } else if (msg?.type) {
    events.push(msg)
  }
})

function rpc(id, body) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no response to ${id}${workerError ? ` (worker error: ${workerError.message})` : ''}`))
    }, 45_000)
    const settle = (fn) => (value) => {
      clearTimeout(timer)
      worker.off('error', onError)
      fn(value)
    }
    const onError = settle(reject)
    const onResolve = settle(resolve)
    worker.once('error', onError)
    pending.set(id, [onResolve])
    worker.postMessage({ requestId: id, ...body })
  })
}

const deadline = Date.now() + 60_000
async function waitFor(fn, what) {
  while (Date.now() < deadline) {
    if (fn()) return
    if (workerError) throw new Error(`worker crashed: ${workerError.stack ?? workerError.message}`)
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timeout waiting for ${what}${workerError ? ` (worker error: ${workerError.message})` : ''}`)
}

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`)
  if (!ok) failures++
}

try {
  await rpc('r-init', {
    operationId: 'op-init',
    type: 'initMemory',
    name: 'smoke.jsonl',
    payload,
  }).then((r) => check('initMemory ok', r.ok, true))

  await rpc('r-index', { operationId: 'op-index', type: 'index' }).then((r) => check('index ok', r.ok, true))
  await waitFor(() => events.some((e) => e.type === 'indexComplete'), 'indexComplete')

  // 64-bit return path: the asm.js bundle dies here.
  const mod = await rpc('r-f1', { operationId: 'op-f1', type: 'filter', kind: 'jq', query: '.i % 2 == 0' })
  check('modulo filter ok', mod.ok, true)
  if (mod.ok) {
    check('modulo matchedRows (evens + blank row not matched)', mod.value.matchedRows, 1500)
    check('modulo totalRows', mod.value.totalRows, 3001)
  }

  // Truthiness: `.tag == "x"` is true for every third row.
  const tag = await rpc('r-f2', { operationId: 'op-f2', type: 'filter', kind: 'jq', query: '.tag == "x"' })
  check('tag filter ok', tag.ok, true)
  if (tag.ok) check('tag matchedRows', tag.value.matchedRows, 1000)

  // A compile error surfaces as a typed failure, not a crash.
  const bad = await rpc('r-f3', { operationId: 'op-f3', type: 'filter', kind: 'jq', query: '.a..' })
  check('compile error ok=false', bad.ok, false)
  check('compile error code', bad.error?.code, 'FILTER_FAILED')
  check('compile error mentions syntax', /syntax error/.test(bad.error?.message ?? ''), true)

  // The module is still alive after the compile error.
  const alive = await rpc('r-f4', { operationId: 'op-f4', type: 'filter', kind: 'jq', query: 'true' })
  check('module alive after error', alive.ok && alive.value.matchedRows, 3000)

  // The worker itself is still responsive (row access on the last filter).
  if (alive.ok) {
    const rows = await rpc('r-rows', {
      operationId: 'op-rows',
      type: 'getRows',
      start: 0,
      count: 5,
      generation: alive.value.generation,
    })
    check('getRows ok', rows.ok, true)
    if (rows.ok) check('getRows totalFiltered', rows.value.totalFiltered, 3000)
  }
} catch (error) {
  failures++
  console.log(`FAIL exception: ${error instanceof Error ? error.message : String(error)}`)
  if (workerError) console.log(`worker error: ${workerError.stack ?? workerError.message}`)
} finally {
  worker.terminate()
}

console.log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
