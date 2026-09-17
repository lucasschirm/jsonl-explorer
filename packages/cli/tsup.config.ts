import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  banner: {
    js: [
      '#!/usr/bin/env node',
      // Bundled CJS deps (fastify/avvio) call require() on node builtins
      // through esbuild's __require shim, which throws in pure ESM.
      // Exposing createRequire(import.meta.url) makes that shim work.
      "import { createRequire as __cliCreateRequire } from 'node:module';",
      'const require = __cliCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  external: [],
  noExternal: ['@fastify/static', 'fastify', 'open'],
  outExtension: () => ({ js: '.mjs' }),
})