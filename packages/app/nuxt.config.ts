// https://nuxt.com/docs/api/configuration/nuxt-config
import { defineNuxtConfig } from 'nuxt/config'
import { jqWasmAssetPlugin } from './vite/jqWasmAsset'

/**
 * Origins allowed to EMBED (frame) the app: same-origin plus the
 * handover allowlist (VITE_HANDOVER_ALLOWED_ORIGINS). The clickjacking
 * policy and the handover trust boundary are the SAME list: only
 * origins trusted to hand data over may frame the app. `*` is dropped
 * (fail closed) — a wildcard frame-ancestors would let any page
 * embed the explorer. (TSK0039: embedding was documented as supported
 * but X-Frame-Options: DENY forbade it; frame-ancestors is now the
 * single framing policy.)
 */
function frameAncestors(allowedOrigins?: string): string {
  const origins = (allowedOrigins ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== '*' && o !== 'same-origin')
  return ["'self'", ...origins].join(' ')
}

// Content Security Policy for module workers, jq (engine/jq.ts), and inline styles.
// The jq backend is the jq-web WASM build: 'wasm-unsafe-eval' covers the
// WebAssembly instantiation in the worker, and the binary is same-origin
// (`/_nuxt/jq.wasm.wasm`, covered by connect-src 'self').
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'", // wasm-unsafe-eval reserved for a WASM jq build, unsafe-inline for Nuxt/Vue
  "style-src 'self' 'unsafe-inline'", // Tailwind/DaisyUI uses inline styles
  "worker-src 'self' blob:", // Web Workers and module workers
  "connect-src 'self' https:", // For URL loading (fetch)
  "font-src 'self' data:", // Fonts
  "img-src 'self' data:", // Images
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${frameAncestors(process.env['VITE_HANDOVER_ALLOWED_ORIGINS'])}`,
].join('; ')

export default defineNuxtConfig({
  ssr: false,
  // SPA mode (Nuxt Content v2): pages run `queryContent()` client-side
  // against the content API served by the nitro server. `useContent()`
  // (documentDriven) throws in a no-SSR app — the /docs pages 500'd
  // until this was set (TSK0045 smoke test caught it).
  content: {
    documentDriven: false,
  },

  app: {
    head: {
      title: 'JSONL Explorer',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Explore, filter, edit and export multi-GB JSONL files in the browser. 100% client-side, no backend required.' },
        { property: 'og:title', content: 'JSONL Explorer' },
        { property: 'og:description', content: 'Explore, filter, edit and export multi-GB JSONL files in the browser. 100% client-side, no backend required.' },
        { property: 'og:type', content: 'website' },
        { property: 'og:url', content: 'https://jsonlexplorer.lucasschirm.com' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: 'JSONL Explorer' },
        { name: 'twitter:description', content: 'Explore, filter, edit and export multi-GB JSONL files in the browser.' },
        { name: 'referrer', content: 'no-referrer' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'robots', href: '/robots.txt' },
      ],

    },
  },

  modules: [
    '@nuxt/content',
    '@pinia/nuxt',
  ],

  css: ['~/assets/css/main.css'],

  vite: {
    plugins: [jqWasmAssetPlugin()],
    optimizeDeps: {
      include: ['jq-web/jq.wasm.js'],
    },
    worker: {
      format: 'es',
    },
  },

  // The `nitro` key is typed via the `@nuxt/nitro-server` module augmentation
  // (see types/nuxt-nitro.d.ts, which keeps it unconditional for fresh
  // checkouts without a generated .nuxt/ directory).
  // Prerendering `/` is what emits the SPA shell index.html for static hosting.
  nitro: {
    routeRules: {
      // Security headers for all routes
      '/**': {
        headers: {
          'Content-Security-Policy': csp,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          // NB: no X-Frame-Options — CSP frame-ancestors (above) is the
          // single framing policy; XFO would contradict the documented
          // embedding support (and is ignored when frame-ancestors exists).
          'X-XSS-Protection': '1; mode=block',
        },
      },
    },
    prerender: {
      routes: ['/'],
      crawlLinks: true,
    },
  },

  compatibilityDate: '2024-01-01',

  runtimeConfig: {
    public: {
      siteUrl: 'https://jsonlexplorer.lucasschirm.com',
      handoverAllowedOrigins: process.env['VITE_HANDOVER_ALLOWED_ORIGINS'] || 'same-origin',
      // Thresholds (can be overridden via env)
      exportBlobFallbackThresholdBytes: Number(process.env['VITE_EXPORT_BLOB_THRESHOLD']) || 512 * 1024 * 1024, // 512 MiB
      rowCacheTargetBytes: Number(process.env['VITE_ROW_CACHE_BYTES']) || 2 * 1024 * 1024, // ~2 MiB target
      maxEditOverrideBytes: Number(process.env['VITE_MAX_EDIT_BYTES']) || 10 * 1024 * 1024, // 10 MiB
      maxHandoverPayloadBytes: Number(process.env['VITE_HANDOVER_MAX_PAYLOAD']) || 100 * 1024 * 1024, // 100 MiB
      largeRowThresholdBytes: Number(process.env['VITE_LARGE_ROW_THRESHOLD']) || 1 * 1024 * 1024, // 1 MiB
    },
  },

  experimental: {
    payloadExtraction: false,
  },
})