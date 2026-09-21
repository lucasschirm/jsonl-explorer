/**
 * Spool session naming and stale-artifact cleanup.
 *
 * Every URL download spools into an OPFS artifact named
 * `spool-<uuid>.jsonl` (random per session, ADR-008). Artifacts are removed
 * on dispose/abort/failure, but a crashed or killed worker can leave them
 * behind; `cleanupStaleSpools` sweeps them at worker startup (and on
 * dispose) so no app-owned data accumulates in OPFS.
 */

export const SPOOL_ARTIFACT_PREFIX = 'spool-'
export const SPOOL_ARTIFACT_SUFFIX = '.jsonl'

/** Cryptographically random ID (with a non-crypto fallback for old runtimes). */
export function randomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** Creates a unique per-session spool artifact name. */
export function createSpoolSessionName(): string {
  return `${SPOOL_ARTIFACT_PREFIX}${randomId()}${SPOOL_ARTIFACT_SUFFIX}`
}

/**
 * Removes all app-owned (`spool-*`) entries from an OPFS root directory.
 * Entries not owned by the app are never touched.
 * @returns the number of artifacts removed.
 */
export async function cleanupStaleSpools(root: FileSystemDirectoryHandle): Promise<number> {
  let removed = 0
  for await (const entry of root.values()) {
    if (entry.kind !== 'file' || !entry.name.startsWith(SPOOL_ARTIFACT_PREFIX)) continue
    try {
      await root.removeEntry(entry.name, { recursive: false })
      removed++
    } catch {
      // Concurrently removed or locked: skip; the next startup retries.
    }
  }
  return removed
}
