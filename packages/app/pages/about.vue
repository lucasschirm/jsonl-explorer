<script setup lang="ts">
/**
 * About page (TSK0051).
 *
 * Credits are GENERATED at build time from the pnpm lockfile + installed
 * package metadata (`scripts/generate-credits.mjs` →
 * `utils/credits.generated.json`) and audited by the license policy
 * (`scripts/licensePolicy.mjs`). The page renders exactly what was
 * generated — no hand-maintained dependency list.
 */
import credits from '~/utils/credits.generated.json'

interface Credit {
  name: string
  version: string
  license: string
  url: string
  licenseText: string
}

const deps = credits.deps as Credit[]
/** Deps whose license comes from a documented policy exception. */
const exceptionNames = new Set(['xmlhttprequest-ssl', 'node-forge'])
</script>

<template>
  <div class="h-screen min-w-[1024px] flex flex-col">
    <!-- Header -->
    <header class="navbar bg-base-100 border-b border-base-300 px-4 shrink-0">
      <div class="navbar-start">
        <span class="text-lg font-semibold text-base-content">JSONL Explorer</span>
      </div>
      <div class="navbar-end">
        <nuxt-link to="/" class="btn btn-ghost btn-sm">← Back to home</nuxt-link>
      </div>
    </header>

    <!-- Main content -->
    <main class="flex-1 overflow-y-auto">
      <div class="max-w-4xl mx-auto w-full p-6 space-y-10">
        <!-- Hero -->
        <section class="space-y-4">
          <h1 class="text-4xl font-bold text-base-content">About JSONL Explorer</h1>
          <p class="text-lg text-base-content/70 max-w-3xl">
            A 100% client-side application for exploring, filtering, editing, and exporting
            large JSONL files. All processing happens in your browser with Web Workers and
            modern browser APIs.
          </p>
        </section>

        <!-- Privacy: what never leaves the machine -->
        <section>
          <h2 class="text-2xl font-semibold text-base-content mb-4">Privacy: local-only by design</h2>
          <div class="space-y-3">
            <div class="alert gap-2">
              <div>
                <strong>Your data never leaves your browser.</strong> File contents are processed
                exclusively in Web Workers on your machine — the app makes no network requests
                with your data. There are no accounts, no telemetry, no analytics. URL-loaded
                files are fetched directly from the source you specify, straight into your
                browser (with your custom headers — which stay in memory and are never logged,
                stored, or sent anywhere except that fetch).
              </div>
            </div>
            <div class="p-4 bg-base-200 rounded-lg text-sm text-base-content/80 space-y-2">
              <p class="font-semibold text-base-content">The optional CLI is a different, still-local, thing.</p>
              <p>
                The <code class="text-mono">jsonlex</code> CLI (npm) is an
                <strong>opt-in</strong> companion: you run it yourself, pointing it at a file
                you choose. It starts a server on <strong>loopback only</strong>
                (<code class="text-mono">127.0.0.1</code>) bound to a cryptographically random
                capability URL, and opens the hosted or bundled explorer with that URL. The
                server serves exactly that one file to the exact explorer page — a wrong URL is
                an unknown route, and non-loopback access is rejected (an explicit
                <code class="text-mono">--insecure-local-network</code> flag is required to even
                try exposing it). It is a convenience for local files, not a backend: the
                browser app itself works fully without it. See the
                <nuxt-link to="/docs/cli" class="link link-token">CLI guide</nuxt-link>.
              </p>
            </div>
          </div>
        </section>

        <!-- Open Source Credits (generated) -->
        <section>
          <h2 class="text-2xl font-semibold text-base-content mb-2">Open source credits</h2>
          <p class="text-sm text-base-content/70 mb-1">
            This project ships code from <strong>{{ deps.length }}</strong> open-source
            packages (the app's declared runtime dependencies and their transitive closure,
            generated from the lockfile — not a hand-maintained list). Every one is audited
            against the project's license policy at build time.
          </p>
          <p class="text-sm text-base-content/70 mb-4">
            The build toolchain (Nuxt, Vite, and friends) is not listed: it runs only while
            building and ships no code to your browser; it is likewise permissively licensed
            and visible in the repository's dev dependencies.
          </p>

          <div class="overflow-x-auto rounded-lg border border-base-300">
            <table class="table table-sm w-full">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Version</th>
                  <th>License</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="dep in deps" :key="`${dep.name}@${dep.version}`" class="align-top">
                  <td>
                    <a
                      :href="dep.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="link link-token font-mono text-sm"
                    >{{ dep.name }}</a>
                    <p v-if="exceptionNames.has(dep.name)" class="text-xs text-base-content/70 mt-1">
                      license via documented policy exception (verified against the shipped LICENSE file)
                    </p>
                  </td>
                  <td class="font-mono text-sm whitespace-nowrap">{{ dep.version }}</td>
                  <td class="whitespace-nowrap">
                    <span class="badge badge-outline badge-sm">{{ dep.license }}</span>
                    <details v-if="dep.licenseText" class="mt-1">
                      <summary class="text-xs link link-token cursor-pointer">license text</summary>
                      <pre class="text-xs bg-base-200 rounded p-2 mt-1 max-h-64 overflow-auto whitespace-pre-wrap">{{ dep.licenseText }}</pre>
                    </details>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="mt-4 p-4 bg-base-200 rounded-lg text-sm text-base-content/70">
            <strong class="text-base-content">This project's license:</strong> JSONL Explorer is
            MIT-licensed. The permissive licenses above (MIT, ISC, BSD, Apache-2.0, 0BSD, CC0,
            BlueOak, …) require that their copyright notices be retained — the full license
            texts of the shipped packages are shown above and are bundled with this page.
          </div>
        </section>

        <!-- Links -->
        <section class="pt-4 border-t border-base-300">
          <div class="flex flex-wrap gap-4 justify-center">
            <a href="https://github.com/lucasschirm/jsonl-explorer" target="_blank" rel="noopener noreferrer" class="btn btn-ghost gap-2">
              GitHub
            </a>
            <a href="https://jsonlexplorer.lucasschirm.com" target="_blank" rel="noopener noreferrer" class="btn btn-ghost gap-2">
              Live demo
            </a>
            <a href="https://www.npmjs.com/package/jsonlex" target="_blank" rel="noopener noreferrer" class="btn btn-ghost gap-2">
              npm (jsonlex CLI)
            </a>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>
