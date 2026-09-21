// https://nuxt.com/docs/api/configuration/nuxt-config
import { defineNuxtConfig } from 'nuxt/config'
import { buildAppCsp, APP_SECURITY_HEADERS } from '@jsonl-explorer/shared'
import { jqWasmAssetPlugin } from './vite/jqWasmAsset'

// ONE CSP source of truth (TSK0054): the same policy is enforced by
// nitro (here), static hosting (scripts/finalize-production-output.mjs
// writes Cloudflare Pages `_headers` from it), and the CLI --local
// server. See packages/shared/src/csp.ts for the directive rationale.
const csp = buildAppCsp(process.env['VITE_HANDOVER_ALLOWED_ORIGINS'])

export default defineNuxtConfig({
  ssr: false,
  // SPA mode (Nuxt Content v2): pages run `queryContent()` client-side.
  // `useContent()` (documentDriven) throws in a no-SSR app — the /docs
  // pages 500'd until this was set (TSK0045 smoke test caught it).
  //
  // experimental.clientDB (TSK0054): the content module only wires the
  // in-memory client DB when `ssr === false` AND this flag is set. Without
  // it, queryContent() is the LEGACY fetch client: every query hits
  // /api/_content/query/<hash>.<integrity>.json — hashed assets that `nuxi
  // generate` does NOT emit (only cache.<integrity>.json). The docs pages
  // then 404 on ANY static host (CLI --local, Cloudflare Pages) while
  // working on the nitro runtime (which computes the assets on demand).
  // With clientDB the browser fetches the ONE cache file and runs every
  // query in memory — the static output is self-contained.
  content: {
    documentDriven: false,
    experimental: {
      clientDB: true,
    },
  },

  // Nuxt wires CSS PostCSS plugins from `nuxt.options.postcss` ONLY — it
  // always sets `vite.css.postcss = { plugins: [] }`, which makes Vite
  // IGNORE a `postcss.config.js` (Nuxt even warns about it). With the
  // config file, `@tailwindcss/postcss` never ran and the build shipped
  // raw `@tailwind`/`@plugin`/`@apply` at-rules: zero Tailwind utilities,
  // zero daisyUI components (TSK0046 e2e caught the unstyled layout).
  postcss: {
    plugins: {
      '@tailwindcss/postcss': {},
    },
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
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
      // Security headers for all routes (shared with the static-hosting
      // _headers and the CLI --local server, TSK0054)
      '/**': {
        headers: {
          'Content-Security-Policy': csp,
          ...APP_SECURITY_HEADERS,
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