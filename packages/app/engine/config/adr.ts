/**
 * JSONL Explorer - Architecture Decision Records (ADR)
 *
 * This document records all critical architecture decisions for the project.
 * Each decision is final and must not be changed without a new ADR entry.
 *
 * Generated from PLAN.md specifications.
 */

// ============================================================================
// DEPLOYMENT TARGET
// ============================================================================
/**
 * ADR-001: Deployment Target
 *
 * Decision: Cloudflare Pages
 *
 * Rationale:
 * - Native support for static site generation (SSG) from Nuxt 3
 * - Free tier generous for static sites
 * - Global CDN with edge caching
 * - Custom domain support (jsonlexplorer.lucasschirm.com)
 * - Built-in HTTPS, security headers, and DDoS protection
 * - GitHub Actions integration for CI/CD
 *
 * Configuration:
 * - Build command: `pnpm generate:app`
 * - Output directory: `packages/app/.output/public`
 * - Node version: 20.11.0 (pinned)
 *
 * References: PLAN.md Phase 0, Phase 9
 */

export const DEPLOYMENT_TARGET = 'cloudflare-pages' as const

// ============================================================================
// SUPPORTED VERSIONS
// ============================================================================
/**
 * ADR-002: Supported Runtime Versions
 *
 * Decision: Pin exact versions for reproducibility
 *
 * Node.js: 20.11.0 (LTS, matches Cloudflare Pages default)
 * pnpm: 9.4.0 (workspace protocol support, fast installs)
 * Nuxt: 3.11.x (latest stable at project start)
 * Vue: 3.4.x
 * TypeScript: 5.4.x
 *
 * Browser Support Matrix:
 * - Chrome: >= 119 (OPFS, File System Access API, BigUint64Array, WASM)
 * - Firefox: >= 120 (OPFS, BigUint64Array, WASM; no File System Access API)
 * - Safari: >= 17.2 (OPFS, BigUint64Array, WASM; no File System Access API)
 * - Edge: >= 119 (same as Chrome)
 *
 * Feature Detection (not UA sniffing):
 * - OPFS: `navigator.storage?.getDirectory`
 * - File System Access API: `window.showSaveFilePicker`
 * - BigUint64Array: `typeof BigUint64Array !== 'undefined'`
 * - Transferable ArrayBuffer: `structuredClone` support test
 * - WebAssembly: `typeof WebAssembly !== 'undefined'`
 *
 * Degradation Policy:
 * - OPFS unavailable → in-memory paging with user consent for large files
 * - File System Access API unavailable → Blob fallback with confirmation >512 MiB
 * - BigUint64Array unavailable → hi/lo Uint32 fallback (tested)
 * - WASM unavailable → jq filter disabled with clear error
 *
 * References: PLAN.md Phase 0, Risks R7, R8, R24
 */

export const SUPPORTED_VERSIONS = {
  node: '20.11.0',
  pnpm: '9.4.0',
  nuxt: '3.11.x',
  vue: '3.4.x',
  typescript: '5.4.x',
} as const

export const BROWSER_SUPPORT = {
  chrome: '>=119',
  firefox: '>=120',
  safari: '>=17.2',
  edge: '>=119',
} as const

export const FEATURE_DETECTION = {
  opfs: 'navigator.storage?.getDirectory',
  fileSystemAccess: 'window.showSaveFilePicker',
  bigUint64Array: 'typeof BigUint64Array !== "undefined"',
  transferableArrayBuffer: 'structuredClone test',
  webAssembly: 'typeof WebAssembly !== "undefined"',
} as const

// ============================================================================
// MEMORY & PERFORMANCE THRESHOLDS
// ============================================================================
/**
 * ADR-003: Memory, Export, Payload, and Large-Row Thresholds
 *
 * All thresholds are configurable via environment variables (VITE_* prefix)
 * and exposed via Nuxt runtimeConfig.public for client access.
 *
 * 1. Export Blob Fallback Threshold: 512 MiB (536,870,912 bytes)
 *    - Above this, show explicit confirmation before Blob fallback
 *    - Env: VITE_EXPORT_BLOB_THRESHOLD
 *    - Config: exportBlobFallbackThresholdBytes
 *
 * 2. Row Cache Target: ~2 MiB (2,097,152 bytes)
 *    - Target memory for main-thread LRU cache (~2000 normal lines)
 *    - Env: VITE_ROW_CACHE_BYTES
 *    - Config: rowCacheTargetBytes
 *
 * 3. Max Edit Override: 10 MiB (10,485,760 bytes)
 *    - Warn before unusually large edit overrides
 *    - Env: VITE_MAX_EDIT_BYTES
 *    - Config: maxEditOverrideBytes
 *
 * 4. Max Handover Payload: 100 MiB (104,857,600 bytes)
 *    - Maximum postMessage payload size
 *    - Env: VITE_HANDOVER_MAX_PAYLOAD
 *    - Config: maxHandoverPayloadBytes
 *
 * 5. Large Row Threshold: 1 MiB (1,048,576 bytes)
 *    - Rows above this default to raw mode, require confirmation for JSON tree
 *    - Env: VITE_LARGE_ROW_THRESHOLD
 *    - Config: largeRowThresholdBytes
 *
 * 6. URL Download Quota Estimate: Request OPFS quota before large downloads
 *    - If Content-Length known and >50% of estimated quota, warn user
 *
 * 7. Worker Message Size Limit: 10 MiB per message
 *    - Batch row windows to stay under this limit
 *
 * References: PLAN.md 4.2, 4.3, 4.5, Risks R4, R6, R16, R19
 */

export const THRESHOLDS = {
  exportBlobFallbackThresholdBytes: 512 * 1024 * 1024, // 512 MiB
  rowCacheTargetBytes: 2 * 1024 * 1024, // ~2 MiB
  maxEditOverrideBytes: 10 * 1024 * 1024, // 10 MiB
  maxHandoverPayloadBytes: 100 * 1024 * 1024, // 100 MiB
  largeRowThresholdBytes: 1 * 1024 * 1024, // 1 MiB
  workerMessageSizeLimitBytes: 10 * 1024 * 1024, // 10 MiB
} as const

// ============================================================================
// POSTMESSAGE ORIGIN CONFIGURATION
// ============================================================================
/**
 * ADR-004: postMessage Handover Origin Configuration
 *
 * Decision: Build-time allowlist with same-origin default
 *
 * Configuration:
 * - Environment variable: VITE_HANDOVER_ALLOWED_ORIGINS (comma-separated)
 * - Default: 'same-origin' (validated at runtime against location.origin)
 * - Embedders must pass expectedOrigin bootstrap parameter
 *
 * Security:
 * - Validates both event.origin AND event.source (opener or parent)
 * - Replies only to validated source and exact origin
 * - Payload size capped at 100 MiB (HANDOVER_MAX_PAYLOAD_BYTES)
 * - Timeout: 30 seconds for load message after ready
 * - Duplicate load messages rejected
 *
 * Allowed Origins Examples:
 * - Production: https://jsonlexplorer.lucasschirm.com
 * - Local dev: http://localhost:3000, http://127.0.0.1:3000
 * - Preview deploys: https://*.pages.dev
 *
 * References: PLAN.md 4.5, Risks R21
 */

export const HANDOVER_CONFIG = {
  namespace: 'jsonl-explorer',
  version: 1,
  maxPayloadBytes: 100 * 1024 * 1024,
  timeoutMs: 30_000,
  defaultAllowedOrigins: ['same-origin'],
} as const

// ============================================================================
// JQ IMPLEMENTATION
// ============================================================================
/**
 * ADR-005: jq Implementation Choice
 *
 * Decision: jq-web (WASM), dynamically imported
 *
 * Rationale:
 * - Real jq semantics in browser (not a subset)
 * - WASM compilation, ~2.5 MB gzipped
 * - Lazy-loaded only when jq: filter first used
 * - Pinned version: 0.5.x (known working)
 * - Isolated behind engine/jq.ts for swapability
 *
 * Risk Mitigation (R14):
 * - jq-web is unmaintained-ish; pin version
 * - Engine isolation allows swap to custom jq-subset or maintained WASM build
 * - Compile once, batch calls, progress/cancel support
 * - Document O(n) parse per row performance
 *
 * Configuration:
 * - WASM URL: /jq-web/jq.wasm (served from public/)
 * - Worker: lazy import in jsonl.worker.ts
 * - Cache: compiled programs cached by query string
 *
 * References: PLAN.md 2, 4.2, Risks R14
 */

export const JQ_CONFIG = {
  package: 'jq-web',
  version: '0.5.x',
  wasmPath: '/jq-web/jq.wasm',
  lazyLoad: true,
  isolateBehind: 'engine/jq.ts',
} as const

// ============================================================================
// BROWSER DEGRADATION BEHAVIORS
// ============================================================================
/**
 * ADR-006: Browser Degradation Behaviors
 *
 * Each missing feature has a defined behavior: warn, confirm, or block.
 *
 * | Feature | Missing Behavior | User Impact |
 * |---------|------------------|-------------|
 * | OPFS | Warn + consent for in-memory fallback | Large URL files may hit memory limits |
 * | File System Access API | Confirm >512 MiB export → Blob fallback | Large exports need confirmation |
 * | BigUint64Array | Auto fallback to hi/lo Uint32 | Transparent, slight perf cost |
 * | Transferable ArrayBuffer | Structured clone (copy) | Higher memory during handover |
 * | WebAssembly (jq-web) | Block jq: filter, show error | Text filter still works |
 * | SharedArrayBuffer | Not used | N/A |
 * | Service Worker | Not used | N/A |
 *
 * References: PLAN.md Phase 0, Risks R7, R8, R24
 */

export const DEGRADATION_BEHAVIOR = {
  opfs: { action: 'warn-consent', fallback: 'memory-paging' },
  fileSystemAccess: { action: 'confirm', thresholdBytes: 512 * 1024 * 1024, fallback: 'blob' },
  bigUint64Array: { action: 'auto-fallback', fallback: 'hi-lo-uint32' },
  transferableArrayBuffer: { action: 'auto-fallback', fallback: 'structured-clone' },
  webAssembly: { action: 'block', feature: 'jq-filter', fallback: 'text-filter-only' },
} as const

// ============================================================================
// CLI CONFIGURATION
// ============================================================================
/**
 * ADR-007: CLI (jsonlex) Configuration
 *
 * Decision: fastify server + tsup zero-dependency bundle
 *
 * Security Model (R1, R20):
 * - Random capability path per run (cryptographically random)
 * - Loopback binding only by default (127.0.0.1)
 * - Non-loopback requires explicit risk confirmation flag
 * - CORS: exact hosted origin only (jsonlexplorer.lucasschirm.com)
 * - PNA: Access-Control-Allow-Private-Network: true
 * - Host/Origin validation on every request
 * - Capability redacted from normal logs
 *
 * Modes:
 * - Remote (default): Serves file via capability URL, opens hosted app
 * - Local (--local): Serves bundled static site + file from same origin
 *
 * Options:
 * - --port <n> (default: ephemeral)
 * - --host <h> (default: 127.0.0.1)
 * - --no-open (don't open browser)
 * - --help, --version
 *
 * Bundle: tsup/esbuild → single file, zero runtime deps
 * Site: Prebuilt .output/public shipped in package (files: ["dist", "site"])
 *
 * References: PLAN.md 4.8, Risks R1, R20
 */

export const CLI_CONFIG = {
  name: 'jsonlex',
  binName: 'jsonlex',
  defaultHost: '127.0.0.1',
  defaultPort: 0, // ephemeral
  capabilityBytes: 32, // 32 bytes = 256 bits entropy
  corsOrigin: 'https://jsonlexplorer.lucasschirm.com',
  pnaHeader: true,
  bundleTarget: 'node20',
  bundleFormat: 'cjs', // single file for CLI
} as const

// ============================================================================
// ENGINE DEFAULTS
// ============================================================================
/**
 * ADR-008: Engine Core Defaults
 *
 * Indexing:
 * - Chunk size: 64 KiB (65,536 bytes) for byte scanning
 * - Offset blocks: Geometric growth (2x), BigUint64Array or hi/lo Uint32
 * - N+1 starts stored (no separate length array)
 * - CRLF handling: strip terminal \r from displayed content
 * - Trailing newline: does not create extra row
 * - Zero-byte source: zero rows
 *
 * Filtering:
 * - Text: case-sensitive literal substring
 * - jq: compile once, apply per row, truthy output = match
 * - Progress: emitted every 1000 rows or 50ms
 * - Cancellation: operationId-scoped, stale-result guards
 *
 * Sources:
 * - FileSource: structured-clone File/Blob, worker-owned slice()
 * - UrlSource: worker-owned fetch → OPFS spool (artifact `spool-<uuid>.jsonl`,
 *   random per session) → indexing. OPFS artifacts are removed on dispose,
 *   abort, and failure; stale `spool-*` artifacts are cleaned at worker
 *   startup. When OPFS is unavailable or its quota is exhausted, the byte
 *   stream falls back to fixed-size in-memory pages (256 KiB) WITHOUT
 *   concatenating the response; large (> maxHandoverPayloadBytes) or
 *   unknown-size responses require explicit user confirmation (the fallback
 *   is never silent). A mid-stream OPFS quota failure re-fetches into RAM.
 *   URL bytes are indexed incrementally as they spool (scanner `feed()`):
 *   committed rows are queryable (filter/getRows/getLine) before the
 *   download completes; `indexComplete` fires when it does. URLs must be
 *   http(s), custom headers are validated/sanitized before fetch, and
 *   credentials (URL userinfo, secret header values) never appear in
 *   error messages or protocol events.
 * - MemorySource: UTF-8 encode string or transfer ArrayBuffer
 *
 * Lifecycle (main-thread worker client):
 * - Exactly one engine/worker on the main thread (module singleton); a new
 *   source init supersedes the old one: in-flight RPCs are rejected as
 *   stale (SourceReplacedError) and the worker resets its source state.
 * - Inits are serialized; a concurrent init fails with InitInProgressError.
 * - Worker crashes are fatal and visible: pending RPCs reject,
 *   onError fires, and recovery requires an explicit reset() which
 *   terminates the dead worker and spawns a fresh one on the next RPC.
 * - dispose() is graceful-then-hard: a 'dispose' RPC (worker cleans spool
 *   artifacts) with a short grace, then terminate(). pagehide disposes the
 *   engine; stale spool artifacts are re-cleaned at the next worker start.
 * - Only scalars, row pages, and export chunks cross the postMessage
 *   boundary; source bytes and offset/match indexes never enter Pinia or
 *   Vue proxies (the engine handle is a shallowRef, never deep-reactive).
 *
 * References: PLAN.md 4.2
 */

export const ENGINE_DEFAULTS = {
  indexChunkSize: 64 * 1024, // 64 KiB
  indexBlockGrowthFactor: 2,
  progressEmitIntervalRows: 1000,
  progressEmitIntervalMs: 50,
  filterProgressIntervalRows: 1000,
  filterProgressIntervalMs: 50,
  maxConcurrentFilterChunks: 4,
  rowPreviewByteLimit: 500, // bytes shown in row list
  largeRowDetailThreshold: 1 * 1024 * 1024, // 1 MiB
  spoolPageSizeBytes: 256 * 1024, // 256 KiB pages for the in-memory URL fallback
} as const

// ============================================================================
// EXPORTS
// ============================================================================
export const ADR_CONFIG = {
  deployment: DEPLOYMENT_TARGET,
  versions: SUPPORTED_VERSIONS,
  browsers: BROWSER_SUPPORT,
  featureDetection: FEATURE_DETECTION,
  thresholds: THRESHOLDS,
  handover: HANDOVER_CONFIG,
  jq: JQ_CONFIG,
  degradation: DEGRADATION_BEHAVIOR,
  cli: CLI_CONFIG,
  engine: ENGINE_DEFAULTS,
} as const

export default ADR_CONFIG