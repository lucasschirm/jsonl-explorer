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
 * URL intake (secret-safe modal, TSK0018):
 * - The page validates URLs (http/https only; embedded userinfo and
 *   fragments rejected) and header rows (token charset, browser-forbidden
 *   names, length caps, CRLF injection, duplicates) in pure functions
 *   (utils/urlIntake.ts) BEFORE anything reaches the worker; the worker
 *   re-validates/sanitizes as defense in depth (engine/url.ts). Both sides
 *   share the RFC 7230 token rule from packages/shared (headers.ts).
 * - The engine receives the URL in its normalized `URL#toString()` form
 *   only. Header values (potentially credentials) travel to the worker
 *   and stay there: they never enter the router, stores, toasts, or logs.
 * - Credential-like header names (Authorization, API keys, tokens, ...) are
 *   flagged with a non-blocking warning and masked in the input field.
 * - A failed URL startup keeps the entered (non-secret) URL in a
 *   memory-only composable (useUrlRecovery) so the landing page can reopen
 *   the modal prefilled for a retry; the value never touches routes or
 *   persistence. The `?url=` bootstrap (R5) is decoded exactly once
 *   (vue-router already decodes), scrubbed through the same rules, and
 *   stripped from the address bar after a successful init.
 *
 * Loading UX (progress, cancellation, consent, TSK0019):
 * - Progress is slot-based in the engine composable: `download`, `index`,
 *   and `filter` slots are independent, so a URL load can show download
 *   percent AND committed rows simultaneously. Determinate percents come
 *   only from plain (unencoded) sizes; compressed/unknown responses are
 *   indeterminate (R12).
 * - File/handover sources start a background index right after init: the
 *   explorer can be entered immediately and rows appear as they commit.
 * - Cancel is operation-scoped: the composable tracks the active
 *   operationId and drops progress events from older operations, so a
 *   cancel/restart can never surface stale progress. A cancelled index
 *   leaves a resumable state ('cancelled'), not an error.
 * - The OPFS-fallback consent (urlFallbackConfirm) is answered by a global
 *   modal (app.vue -> FallbackConfirmModal); until it answers, the worker
 *   pauses the download. A stale consent (source reset/fatal) is answered
 *   false — never a silent fallback.
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
  // Main-thread row-window cache (TSK0021): a BYTE budget, not just an
  // entry count — previews are small but unbounded in count. ~4 MiB of
  // previews ≈ 8k typical rows (516 B each) ≈ 1.6k worst-case escaped rows.
  rowCacheMaxBytes: 4 * 1024 * 1024,
  rowCacheMaxEntries: 20000,
} as const

// ============================================================================
// EXPLORER SHELL (TSK0020)
// ============================================================================
/**
 * Explorer shell and minimum viewport (TSK0020):
 * - The /explorer shell is a split view: fixed-width row list (left) and a
 *   flexible detail pane (right) under a small (48px) fixed header. The
 *   panels scroll independently; the header never scrolls away.
 * - Minimum supported viewport: 1024px wide. Below that the page keeps its
 *   1024px min width and scrolls horizontally instead of stacking the
 *   panels. Stacking is rejected: data exploration is a desktop activity,
 *   and a stacked split view would break the row/detail mental model and
 *   the virtualized row list's fixed-height assumptions.
 * - The guard (R5) is three distinct paths: (1) `?url=` bootstrap present
 *   -> consume it first (never redirect before attempting it); (2) a
 *   source already loaded -> stay (initialized navigation); (3) neither
 *   -> redirect to / with an info toast (refresh loses in-memory state by
 *   design).
 * - "Upload another file" FULLY disposes the engine (not just the source):
 *   the worker-side dispose RPC (spool cleanup) is posted, the worker is
 *   terminated, and all worker-side caches go with it. The next load
 *   lazily creates a fresh engine, so no resources leak across sources.
 *
 * References: PLAN.md 4.3 (guard R5, header, layout)
 */

// ============================================================================
// ROW WINDOW AND CACHING (TSK0021)
// ============================================================================
/**
 * Batched row-window retrieval and bounded LRU caching (TSK0021):
 * - The worker is the single source of truth for the display->lineId
 *   mapping. Unfiltered, it is the IDENTITY (display i == row i, lineId
 *   i+1) — no match list the size of the file is ever materialized.
 *   After a filter completes, display positions map through the filter's
 *   matched-rows snapshot (R3 replace semantics); a failed/cancelled
 *   filter never changes the view.
 * - `getRows` returns list PREVIEWS: only the first rowPreviewByteLimit
 *   (500 B) of each row is read and transferred, with C0/DEL control
 *   characters escaped so the preview always renders on one line.
 *   `byteLength` still reports the FULL row size. Full (unescaped) text
 *   is fetched separately via `getLine` — the detail panel parses it as
 *   JSON, so control characters must survive.
 * - The main-thread row store (stores/rows.ts) coalesces every window
 *   request (viewport + overscan) into ONE in-flight getRows RPC; a
 *   scrolling virtualizer only widens the desired range. The cache is
 *   keyed by (generation, lineId) and bounded by a BYTE budget plus an
 *   entry cap (rowCacheMaxBytes/Entries) — never entry count alone (R12).
 *   LRU eviction never removes rows inside the current desired window.
 * - Generations: the worker's `indexComplete` event carries the post-
 *   commit generation; getRows responses echo the generation they were
 *   computed for. A response NEWER than the store's generation is fresh
 *   (adopt + apply); one OLDER is stale and is NEVER applied (no
 *   downgrade). Filter completion (filter store's generation) and index
 *   commits invalidate the cache; a new source resets it via
 *   fileStore.resetDerivedState().
 * - Exports follow the same identity rule: only a filtered view copies
 *   its bounded snapshot; the identity view resolves rows on the fly.
 *
 * References: PLAN.md 4.3 (row list, memory R12)
 */

// ============================================================================
// VIRTUALIZED ROW LIST (TSK0022)
// ============================================================================
/**
 * Virtualized row list (TSK0022):
 * - Rows are rendered through @tanstack/vue-virtual with a FIXED row
 *   height (28 px): previews are single-line (truncated, C0/DEL
 *   pre-escaped by the worker), so no per-row measurement exists and the
 *   virtualizer never measures DOM nodes.
 * - The window handed to the row store is the virtualizer's
 *   getVirtualItems() range, i.e. viewport PLUS overscan (the core's raw
 *   `range` excludes overscan; handing it out would leave overscanned
 *   rows as permanent placeholders). The store coalesces it into one
 *   in-flight RPC (TSK0021).
 * - The vue wrapper only unrefs the TOP-LEVEL options object, so the
 *   options are passed as a `computed` (with count unwrapped inside);
 *   a plain object would hand the core a Ref and break measurements.
 * - The core only notifies on element/rect/scroll changes — never on a
 *   count-only change — so RowList additionally watches the store's
 *   totalFiltered/generation and re-derives the window on nextTick (the
 *   wrapper's own options watch must have applied the new count first).
 * - Placeholder flipping is driven by the row store's `version` signal
 *   (read once in the list template): the display->line cache is a
 *   plain Map, so renders of pending rows would otherwise track no
 *   reactive state and never update when their rows arrive.
 * - Row identity for highlight/selection is the STABLE lineId
 *   (selection store's activeLineId), never a display index, so filter
 *   changes cannot drift the highlighted row. The DOM node count stays
 *   bounded by (viewport / rowHeight + 2 * overscan) for any file size.
 * - `initialRect` prop: deterministic viewport for tests/embeds (happy-
 *   dom measures 0x0); when set, element rect observation is replaced by
 *   the fixed rect. Production leaves it unset (live ResizeObserver).
 *
 * References: PLAN.md 4.3 (row list), TSK0021 (window retrieval)
 */

// ============================================================================
// SELECTION TRANSITIONS AND KEYBOARD NAVIGATION (TSK0023)
// ============================================================================
/**
 * Selection transitions and keyboard navigation (TSK0023):
 * - The WORKER is authoritative for selection transitions. When the view
 *   changes (filter completion, index commit), the selection store asks
 *   the worker `linePosition(lineId)`: visible -> KEEP the active row at
 *   the returned display index; not visible + rows remain -> REPLACE with
 *   the first result; not visible + zero rows -> CLEAR. The main thread
 *   never re-derives "still matched?" locally — the filter snapshot
 *   lives in the worker, and a local guess would fork on every view
 *   change. `positionOfLine` is an O(log n) binary search on the worker's
 *   matched-rows Uint32Array (identity view: row < committedRows).
 * - Answers carry the worker generation and are GUARDED: an answer that
 *   no longer matches the current generation (a newer view superseded
 *   the request) is dropped, so slow RPCs cannot apply stale decisions.
 * - `activeLineId` is the stable source line id; `activeDisplayIndex` is
 *   its position in the CURRENT view (null until known). The first
 *   complete row auto-selects once row 0 is cached (initial load and
 *   after a replace); source replacement clears everything via
 *   fileStore.resetDerivedState().
 * - The status bar (explorer/StatusBar.vue) shows only worker-snapshot
 *   numbers: total (from indexComplete), filtered (from the worker's
 *   getRows/filter snapshots) — plus state text (indexing %/paused/
 *   failed, filtering scanned/matched) and a partial marker while the
 *   index is incomplete (the total is then a lower bound).
 * - Keyboard navigation: ArrowUp/ArrowDown on the focused list scroller
 *   move the active row with clamped boundaries (no wrap, no movement
 *   on an empty view). The target row is fetched on demand (single-row
 *   window) when not cached; activation lands when it arrives. The
 *   handler ignores events whose target is an editable element
 *   (input/textarea/select/contentEditable) so future in-list editors
 *   are never hijacked.
 *
 * References: PLAN.md 4.3 (explorer), TSK0022 (row list, selection store)
 */

// ============================================================================
// DETAIL LOADER AND READ-ONLY JSON TREE (TSK0024)
// ============================================================================
/**
 * Detail loader and read-only JSON tree (TSK0024):
 * - The detail loads the FULL text of the active row on demand
 *   (getLine) — list previews stay byte-capped; the detail is exact
 *   and unescaped (control characters survive for parsing).
 * - Stale-load cancellation is token-based: each load bumps a token;
 *   an answer that no longer matches the token OR the active line id
 *   is dropped. Rapid selection can never render a row the user has
 *   already left (no "flash of the previous row").
 * - The tree (JsonTree/JsonNode) renders the PARSED value; collapse
 *   state is per-node local state — independent, and never a mutation
 *   of the value or the source row. Containers with more than 50
 *   children start collapsed (DOM guard on first render).
 * - Token styling uses DaisyUI semantic color utilities (theme-aware
 *   CSS variables): key=primary, string=success, number=warning,
 *   boolean=info, null=dimmed italic. No hardcoded colors.
 * - Invalid JSON rows render as raw text with a role=alert banner and
 *   a one-time toast on selection — the row is displayed, never
 *   repaired or rewritten.
 * - Rows above ENGINE_DEFAULTS.largeRowDetailThreshold (1 MiB) default
 *   to RAW mode; the tree is parsed/rendered only after explicit
 *   confirmation ("View as JSON tree"). A single giant row cannot
 *   freeze the UI automatically.
 * - Format/Compact are PRESENTATION-only (detail store viewMode): they
 *   decide how the parsed document is serialized for text consumers
 *   (copy/export, TSK0031+). They never post setEdit and never change
 *   the worker's text.
 *
 * References: PLAN.md 4.3 (right panel), TSK0021 (getLine, previews)
 */

// ============================================================================
// VIRTUALIZED RAW VIEW AND COPY ACTIONS (TSK0025)
// ============================================================================
/**
 * Virtualized raw view and copy actions (TSK0025):
 * - "Raw" opens a MODAL that virtualizes the current (filtered) dataset
 *   — the same @tanstack/vue-virtual pattern, the same bounded row
 *   windows/cache, the same display-index -> lineId mapping as the row
 *   list. The dataset is NEVER concatenated into one string: DOM and
 *   memory stay bounded by the viewport regardless of filtered size.
 * - Raw rows reuse the list's preview semantics exactly (byte-capped,
 *   C0/DEL-escaped, single line) plus the source line number; full
 *   text is only materialized per-row on Copy (getLine).
 * - Copy actions (detail panel: selected row; raw modal: any row) go
 *   through one helper (utils/clipboard.ts): async Clipboard API,
 *   execCommand fallback, REJECTION on failure — callers show a typed
 *   error toast. Copying never fails silently.
 * - Invalid-JSON toast policy is non-duplicating: one toast per invalid
 *   row per context (the banner is always visible; re-selecting the
 *   same row does not re-toast; a different row does).
 * - Modal accessibility is inherited from the shared Modal (focus trap,
 *   Escape, backdrop close, role=dialog aria-modal, focus restore).
 *
 * References: PLAN.md 4.3 (raw view), TSK0022 (virtualization),
 *           TSK0024 (detail panel, invalid-JSON states)
 */

// ============================================================================
// LITERAL TEXT FILTERING (TSK0026)
// ============================================================================
/**
 * Literal text filtering (TSK0026):
 * - The match index is a SEPARATE structure from the source index:
 *   matched source lineIds (Uint32Array, ascending) plus a count. Memory is
 *   bounded by the number of matched row IDs — never by parsed rows or
 *   decoded text. The previous view stays served while a scan runs.
 * - A scan builds its result OFF-TO-SIDE (a local buffer) and swaps it in
 *   atomically at the end (kind, query, program, match IDs, and count all
 *   flip together). A cancelled or failed scan discards its buffer: the
 *   previous view is untouched, and getRows/linePosition keep working.
 * - Cancellation is cooperative and token-based: each filter() bumps a
 *   scan token; the in-flight scan checks `token === current` per row, so a
 *   newer filter or an explicit cancel supersedes the old scan. The
 *   superseded RPC is answered FILTER_CANCELLED — a typed outcome, not an
 *   error (the store returns to idle and keeps the previous result).
 * - Rows are matched on their decoded DISPLAY text (the same bytes the UI
 *   shows: CR-stripped, terminal LF excluded, non-fatal UTF-8). Matching is
 *   per-row and case-sensitive (literal `includes`); a query can never
 *   span two rows. Blank rows are real rows: they match the empty query
 *   only.
 * - Edited rows (TSK0030 owns the edit store) match against their OVERRIDE
 *   text through an injected lookup — the scan never reads source bytes for
 *   overridden rows. The worker keeps the override map (empty until
 *   TSK0030 populates it via setEdit); the engine stays agnostic.
 * - While the index is still building (URL streaming), a filter over the
 *   committed snapshot is valid but PARTIAL: FilterResult and the
 *   filterComplete event carry `partial`. The worker auto-reruns the
 *   latest query at indexComplete (its own operationId, a filterComplete
 *   event — no RPC in flight) so the user ends on the final result without
 *   re-typing. The store adopts a filterComplete event only if its
 *   generation is newer than the stored result (per-source generations are
 *   monotonic; a new source resets the filter state).
 * - Progress events are throttled to one per PROGRESS_INTERVAL_ROWS rows
 *   (and always at the end), and carry `totalRows` so the UI can render a
 *   determinate bar.
 *
 * References: PLAN.md 4.1/4.2 (search), TSK0012 (source index),
 *           TSK0021 (row windows, display mapping)
 */

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