/**
 * Stable module augmentation for the `nitro` config key.
 *
 * `@nuxt/nitro-server` augments `@nuxt/schema`'s `NuxtConfig` with
 * `nitro?: NitroConfig`, but that declaration file is only pulled into the
 * program when the generated `.nuxt/nuxt.d.ts` references it. On a fresh
 * checkout (CI runs typecheck before any build, so `.nuxt/` does not exist)
 * the `nitro` key in `nuxt.config.ts` would fail with TS2353.
 *
 * Referencing the package's types here makes the augmentation unconditional,
 * so typechecking passes with or without a generated `.nuxt/` directory.
 */
/// <reference types="@nuxt/nitro-server" />

export {}
