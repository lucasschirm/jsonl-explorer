/**
 * Type shims for unit tests.
 *
 * The main tsconfig excludes `tests/**` and never imports SFCs from `.ts`,
 * so plain `tsc` never needs `.vue` resolution. The test tsconfig
 * (`tsconfig.test.json`) includes the specs, which import SFCs directly;
 * this shim gives those imports a sound (if loose) component type.
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
