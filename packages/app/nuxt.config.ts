// https://nuxt.com/docs/api/configuration/nuxt-config
import { defineNuxtConfig } from 'nuxt/config'

// Content Security Policy for module workers, jq WASM, and inline styles
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'", // wasm-unsafe-eval for jq-web, unsafe-inline for Nuxt/Vue
  "style-src 'self' 'unsafe-inline'", // Tailwind/DaisyUI uses inline styles
  "worker-src 'self' blob:", // Web Workers and module workers
  "connect-src 'self' https:", // For URL loading (fetch)
  "font-src 'self' data:", // Fonts
  "img-src 'self' data:", // Images
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'", // Allow embedding in same origin
].join('; ')

export default defineNuxtConfig({
  ssr: false,

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
    optimizeDeps: {
      include: ['jq-web'],
    },
    worker: {
      format: 'es',
    },
  },

  nitro: {
    routeRules: {
      // CSP headers for all routes
      '/**': {
        headers: {
          'Content-Security-Policy': csp,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
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
      jqWasmUrl: '/jq-web/jq.wasm',
    },
  },

  experimental: {
    payloadExtraction: false,
  },
})