# Releasing `jsonlex`

The npm package `jsonlex` is published **only** by
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which
runs **only on version tags** (`vX.Y.Z`). Branches and pull requests can
never trigger a publish, and the workflow holds **no npm token**: it
publishes via npm **trusted publishing** (OIDC) with **provenance**.

## One-time prerequisites (npm package owner)

1. The npm package `jsonlex` exists (create it first if the name is still
   available: `npm adduser` + claim the name, or create it via the npmjs
   dashboard).
2. Enable **Trusted Publishing** for this repository:
   npmjs.com → package `jsonlex` → *Package settings* → *Publishing* →
   *Trusted Publishers* → **Add a trusted publisher** → select the
   `lucasschirm/jsonl-explorer` repository (any environment). The workflow's
   `id-token: write` permission is all it needs from GitHub.
3. (Optional) Add a protected GitHub environment and reference it in
   `release.yml` to require a human approval before the publish step.

Until both are in place, pushing a tag runs the whole gate and then fails at
the publish step (no trusted publisher) — nothing is published, and the run
is safe to re-trigger after setup.

## How to release

```bash
# 1. Make sure main is green (CI) and the changes you want in the release
#    are on main.

# 2. Tag the release — an ANNOTATED tag doubles as the release notes:
git tag -a v1.2.0 -m "Release v1.2.0

- <change summary>
- <user-facing notes>"

git push origin v1.2.0
```

The workflow then: validates the tag → checks the version is **not already
on npm** (versions are immutable) → runs the full gate (`pnpm gate`:
lint, typecheck, docs, credits, unit incl. the packed-artifact suite,
build, production output validation, e2e) → stamps `version` +
`private=false` on the CI checkout (the committed package.json stays
`0.0.0`/`private: true`, so a stray local `npm publish` can never ship a
wrong version) → `npm publish --access public --provenance` → post-publish
smoke (`npx jsonlex@X.Y.Z --help/--version` in a clean environment).

**Release notes**: the annotated tag message is the canonical release
notes; mirror it on the GitHub Releases page if you want them visible on
the repo (optional, cosmetic).

## Rollback / deprecation

npm versions are **immutable** — you cannot republish, overwrite, or edit a
published version. The tools are:

1. **Deprecate** (preferred, immediate, survives forever):
   ```bash
   npm deprecate jsonlex@1.2.3 "broken export on Node 20 — upgrade to 1.2.4"
   ```
   `npx jsonlex@1.2.3` and `npm i jsonlex@1.2.3` then print the warning;
   unpinned installs (`npx jsonlex`, `npm i jsonlex`) skip deprecated
   versions automatically.
2. **Fix and release the next patch** (`v1.2.4`) — the normal path.
3. **Unpublish** (last resort): `npm unpublish jsonlex@1.2.3` — subject to
   npm policy (within 72 h of publish, or the package is <5 versions old,
   and it removes the version entirely). For a package with dependents,
   prefer deprecate + fix over unpublish.
4. **Yank the tag** locally/remotely if the release never completed:
   `git push origin :refs/tags/v1.2.3` — no npm state is affected.

## What the workflow guarantees

- No publish from branches, PRs, or manual dispatch.
- No publish credentials in the repo or in secrets (OIDC only).
- The version in the tag is exactly the version published; an already-
  published version fails the run before any work.
- The published tarball is the packed artifact the integration suite
  already verified (bin, staged site, LICENSE, engines, zero runtime
  dependencies) — see `packages/cli/tests/integration/packed.spec.ts`.
- Every published version carries npm **provenance** (cryptographically
  links it to this repository + commit).
