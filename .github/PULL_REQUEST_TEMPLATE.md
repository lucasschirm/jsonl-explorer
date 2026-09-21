## What & why

<!-- One paragraph: what this changes and why. Link the task/issue it closes. -->

## Checklist

### Correctness

- [ ] Behavior is covered by tests at the right layer (unit for logic; e2e for
      browser, protocol, and security flows)
- [ ] New/changed async paths use typed errors with actionable UI/CLI output —
      **no silent failures** (no swallowed `catch`; intentional non-fatal
      failures print/say why)
- [ ] No new reactive state that scales with file size (worker owns data;
      Pinia holds UI state/metadata only)
- [ ] Resources are disposed (workers, object URLs, writable handles, fetches,
      OPFS artifacts) on reset/failure/abort, and startup cleans stale state

### Hygiene

- [ ] `pnpm gate` passes locally (lint, typecheck, docs, credits, unit, build,
      e2e)
- [ ] Docs affected by this change are updated in the same change (guides,
      README, `docs/`)
- [ ] No temporary debug logs, no committed build output, no secrets
- [ ] `packages/shared` changes were rebuilt before app typecheck/e2e

### Security (only if the PR touches URLs, headers, postMessage, CLI serving,

or CSP)

- [ ] Origin/Host/source validation is explicit (no `*` where a specific origin
      is meant)
- [ ] Secrets (auth headers, capability tokens) never reach URLs, history,
      logs, error messages, or analytics
- [ ] New e2e coverage for the denied path, not just the allowed path

## Evidence

<!-- Commands run + results (counts), and anything a reviewer must reproduce
     manually (browser-specific behavior, visual checks). -->
