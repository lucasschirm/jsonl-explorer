/**
 * The app's Content-Security Policy — ONE source of truth (TSK0054).
 *
 * The same policy must be enforced everywhere the app is served:
 * - nitro (dev/preview/`nuxi build` server) via nuxt.config routeRules;
 * - static hosting (Cloudflare Pages) via the generated `_headers` file;
 * - the CLI's `--local` static server.
 *
 * Keeping it here (built JS, importable from nuxt.config, the CLI, and
 * plain .mjs scripts) is what makes drift between those surfaces a
 * compile-time/CI problem instead of a silent security gap.
 */

/**
 * Origins allowed to EMBED (frame) the app: same-origin plus the
 * handover allowlist. The clickjacking policy and the handover trust
 * boundary are the SAME list: only origins trusted to hand data over may
 * frame the app. `*` is dropped (fail closed) — a wildcard
 * frame-ancestors would let any page embed the explorer, and
 * `same-origin` is not a valid frame-ancestors token ('self' means it).
 * Entries are comma- OR whitespace-separated (env values are written
 * both ways); an unsplit `* …same-origin` blob would otherwise sail
 * through the filter as one "origin" (caught by TSK0054 tests).
 */
export function frameAncestors(allowedOrigins?: string): string {
  const origins = (allowedOrigins ?? '')
    .split(/,|\s+/)
    .filter((o) => o.length > 0 && o !== '*' && o !== 'same-origin')
  return ["'self'", ...origins].join(' ')
}

/**
 * Full CSP for the explorer app.
 *
 * - `wasm-unsafe-eval`: WebAssembly.instantiate in the worker (the jq-web
 *   WASM build, engine/jq.ts).
 * - `script-src 'unsafe-inline'`: Nuxt/Vite inline bootstrap scripts.
 * - `worker-src 'self' blob:`: module workers (the engine worker).
 * - `connect-src 'self' https:`: the app fetches user-supplied https URLs
 *   (URL source) — the core feature; everything else is same-origin.
 */
export function buildAppCsp(allowedOrigins?: string): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "connect-src 'self' https:",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors(allowedOrigins)}`,
  ].join('; ')
}

/** Non-CSP security headers shared by every serving surface. */
export const APP_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const
