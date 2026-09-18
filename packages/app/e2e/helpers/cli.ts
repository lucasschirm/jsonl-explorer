/**
 * TSK0045 — CLI launch helper for the browser suites.
 *
 * Launches the BUILT CLI (`packages/cli/dist/index.mjs` — built by the
 * root `pnpm build` that must run before e2e) in `--local --no-open` mode
 * on a free port, waits for the server, and parses the URLs from the
 * intentional --no-open prints. The caller must `close()` the handle.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export const CLI_BIN = resolve(here, '..', '..', '..', 'cli', 'dist', 'index.mjs')

export interface CliHandle {
  port: number
  baseUrl: string
  /** Full capability URL (from the --no-open print). */
  fileUrl: string
  /** Explorer URL the CLI would open (same-origin bootstrap). */
  explorerUrl: string
  close(): Promise<void>
}

export interface LaunchCliOptions {
  /** `--local` (default): same-origin policy, serves the static site.
   *  Remote mode: hosted-origin policy (capability + PNA headers only —
   *  the hosted app itself is out of reach in e2e). */
  local?: boolean
}

export function findFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createNetServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolvePort(port))
    })
    srv.on('error', rejectPort)
  })
}

export async function launchCli(file: string, port: number, options: LaunchCliOptions = {}): Promise<CliHandle> {
  const local = options.local ?? true
  const args = [CLI_BIN, file, '--no-open', '--port', String(port)]
  if (local) args.splice(1, 0, '--local')
  const child: ChildProcess = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  child.stdout?.on('data', (d) => (buffer += String(d)))
  child.stderr?.on('data', (d) => (buffer += String(d)))

  const started = await waitForText('Server running', () => buffer, 30_000)
    .catch(() => {
      child.kill('SIGKILL')
      throw new Error(`CLI did not start. Output:\n${buffer}`)
    })
  void started

  const fileUrl = /File served at (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/file\.jsonl)/.exec(buffer)?.[1]
  const explorerUrl = /Explorer URL: (\S+)/.exec(buffer)?.[1]
  if (!fileUrl || !explorerUrl) {
    child.kill('SIGKILL')
    throw new Error(`CLI prints missing (fileUrl/explorerUrl). Output:\n${buffer}`)
  }

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    fileUrl,
    explorerUrl,
    async close(): Promise<void> {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>((resolveClose) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          resolveClose()
        }, 5_000)
        child.on('close', () => {
          clearTimeout(t)
          resolveClose()
        })
      })
    },
  }
}

async function waitForText(pattern: string, get: () => string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (get().includes(pattern)) return
    await new Promise<void>((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for "${pattern}"`)
}
