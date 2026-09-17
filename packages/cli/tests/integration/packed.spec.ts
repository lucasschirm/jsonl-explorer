/**
 * TSK0044 — integration tests against the ACTUAL packed artifact.
 *
 * Packs the package (pnpm pack), installs the tarball into a clean
 * temporary project (npm install — exactly what a user gets), and runs
 * `node node_modules/jsonlex/dist/index.mjs` — never the workspace source.
 * Covers: help/version, bad inputs, unknown options, --local --no-open
 * serving (capability URL parsed from the intentional --no-open print),
 * adversarial requests, port conflict, browser-open failure, and signal
 * shutdown.
 *
 * Platform notes (CI is Linux): on Windows, SIGTERM maps to a process
 * abort rather than a Unix signal — the graceful-shutdown path is still
 * exercised via SIGINT-equivalent behaviour, but the exit code may differ;
 * on macOS everything here is equivalent. npm must be available (it ships
 * with Node).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cliRoot = resolve(here, '..')

let work: string
let proj: string
let cliBin: string
const children: ChildProcess[] = []

function freePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const srv = createNetServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolvePort(port))
    })
    srv.on('error', rejectPort)
  })
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliBin, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { code?: number | null; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }
  }
}

/** Starts a long-lived CLI server; the caller must kill() it. */
function startCli(args: string[]): { child: ChildProcess; out: () => string } {
  const child = spawn(process.execPath, [cliBin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let buffer = ''
  child.stdout?.on('data', (d) => (buffer += String(d)))
  child.stderr?.on('data', (d) => (buffer += String(d)))
  return { child, out: () => buffer }
}

async function waitFor(pattern: string, get: () => string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (get().includes(pattern)) return
    await new Promise<void>((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for "${pattern}". Output so far:\n${get()}`)
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolveKill) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL')
      resolveKill()
    }, 5_000)
    child.on('close', () => {
      clearTimeout(t)
      resolveKill()
    })
  })
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'jsonlex-packed-'))
  proj = join(work, 'project')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'jsonlex-proj', version: '0.0.0' }))

  // Pack the real package, then install the tarball into the clean project
  // — exactly what a user gets.
  execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: cliRoot, stdio: 'pipe' })
  const tarball = join(work, 'jsonlex-0.0.0.tgz')
  execFileSync('npm', ['install', tarball, '--no-audit', '--no-fund', '--loglevel', 'error'], {
    cwd: proj,
    stdio: 'pipe',
    timeout: 180_000,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  })

  cliBin = join(proj, 'node_modules', 'jsonlex', 'dist', 'index.mjs')
  const installed = readFileSync(join(proj, 'node_modules', 'jsonlex', 'package.json'), 'utf8')
  if (!installed.includes('"name": "jsonlex"') || installed.includes('"dependencies"')) {
    throw new Error('packed install is malformed (name or runtime deps)')
  }
}, 300_000)

afterAll(async () => {
  for (const child of children) await kill(child).catch(() => {})
  rmSync(work, { recursive: true, force: true })
})

describe('packed CLI: help/version/inputs', () => {
  it('--help exits 0 with usage', () => {
    const r = runCli(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Usage:')
    expect(r.stdout).toContain('--insecure-local-network')
  }, 30_000)

  it('--version exits 0 with the package version', () => {
    const r = runCli(['--version'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('0.0.0')
  }, 30_000)

  it('missing file argument: exit 1, actionable', () => {
    const r = runCli([])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Missing required argument <file>')
  }, 30_000)

  it('nonexistent file: exit 1', () => {
    const r = runCli([join(work, 'nope.jsonl')])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('File not found')
  }, 30_000)

  it('directory as file: exit 1', () => {
    const r = runCli([work])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Not a regular file')
  }, 30_000)

  it('unknown option: exit 1', () => {
    const r = runCli([join(work, 'x.jsonl'), '--bogus'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Unknown option')
  }, 30_000)
})

describe('packed CLI: --local --no-open serving', () => {
  let port: number

  beforeAll(async () => {
    port = await freePort()
  }, 60_000)

  it('serves the staged site and the capability file end to end', async () => {
    const data = '{"i":1}\n{"i":2}\n'
    const file = join(work, 'data.jsonl')
    writeFileSync(file, data)

    const { child, out } = startCli([file, '--local', '--no-open', '--port', String(port)])
    await waitFor('Server running', out)
    try {
      const base = `http://127.0.0.1:${port}`
      // The --no-open print carries the full file URL (intentional).
      const urlMatch = /File served at (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/file\.jsonl)/.exec(out())
      expect(urlMatch?.[1]).toBeTruthy()
      const fileUrl = urlMatch![1]!

      // The file: exact bytes.
      const fileRes = await fetch(fileUrl)
      expect(fileRes.status).toBe(200)
      expect(await fileRes.text()).toBe(data)

      // A range: 206 + exact slice.
      const rangeRes = await fetch(fileUrl, { headers: { range: 'bytes=0-4' } })
      expect(rangeRes.status).toBe(206)
      expect(await rangeRes.text()).toBe('{"i":')

      // Adversarial: wrong capability, traversal, POST, bad range, foreign origin.
      expect((await fetch(base + '/deadbeef/file.jsonl')).status).toBe(404)
      expect((await fetch(base + '/..%2f..%2fetc%2fpasswd')).status).toBe(404)
      expect((await fetch(fileUrl, { method: 'POST' })).status).toBe(404)
      expect((await fetch(fileUrl, { headers: { range: 'bytes=999-' } })).status).toBe(416)
      expect((await fetch(fileUrl, { headers: { origin: 'https://evil.com' } })).status).toBe(403)

      // The staged site: index + immutable asset caching.
      const index = await fetch(base + '/')
      expect(index.status).toBe(200)
      expect((index.headers.get('content-type') ?? '').includes('text/html')).toBe(true)
      expect(index.headers.get('cache-control')).toBe('no-store')
      const asset = await fetch(base + '/robots.txt')
      expect(asset.status).toBe(200)
      expect(asset.headers.get('cache-control')).toContain('immutable')
      expect((await fetch(base + '/_nuxt/')).status).toBe(404) // no listing
    } finally {
      // Always release the port, even on assertion failure.
      await kill(child)
    }
    expect(child.exitCode).toBe(0) // graceful SIGTERM
  }, 60_000)

  it('port conflict: second server on the same port exits 1 with an actionable error', async () => {
    const file = join(work, 'conflict.jsonl')
    writeFileSync(file, '{"x":1}\n')
    const first = startCli([file, '--local', '--no-open', '--port', String(port)])
    try {
      await waitFor('Server running', first.out)
      const second = runCli([file, '--local', '--no-open', '--port', String(port)])
      expect(second.code).toBe(1)
      expect(second.stderr).toContain('already in use')
    } finally {
      await kill(first.child)
    }
  }, 60_000)

  it('browser-open failure does not kill the server (headless environments)', async () => {
    const file = join(work, 'open.jsonl')
    writeFileSync(file, '{"y":1}\n')
    const p2 = await freePort()
    // Default mode attempts to open a browser; on a headless box that
    // fails — the server must warn and keep running.
    const { child, out } = startCli([file, '--port', String(p2)])
    await waitFor('Server running', out)
    await waitFor('Opening:', out)
    // Health stays up regardless of whether a browser launched.
    const health = await fetch(`http://127.0.0.1:${p2}/health`)
    expect(health.status).toBe(200)
    await kill(child)
  }, 60_000)

  it('SIGTERM shuts down cleanly', async () => {
    const file = join(work, 'sig.jsonl')
    writeFileSync(file, '{"z":1}\n')
    const p3 = await freePort()
    const { child, out } = startCli([file, '--local', '--no-open', '--port', String(p3)])
    await waitFor('Server running', out)
    child.kill('SIGTERM')
    await new Promise<void>((r) => child.on('close', r))
    expect(child.exitCode).toBe(0)
    expect(out()).toContain('shutting down')
  }, 60_000)
})
