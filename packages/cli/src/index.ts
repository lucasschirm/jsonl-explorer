/**
 * jsonlex - JSONL Explorer CLI
 *
 * NB: the executable shebang comes from tsup's banner (dist/index.mjs
 * must have exactly ONE, on line 1 — a second `#!` line is a syntax
 * error in ESM).
 *
 * Serves a JSONL file via a local Fastify server and opens the JSONL Explorer
 * in the browser with a capability-protected URL.
 *
 * Argument contract (TSK0040):
 * - exactly ONE positional (the file); extra positionals are a typed error;
 * - unknown options are a typed error (parseArgs strict mode, mapped here);
 * - duplicate options: the LAST occurrence wins (standard CLI convention);
 * - `--` ends option parsing: everything after it is positional, so files
 *   whose names start with `-` can be passed as `jsonlex -- -weird.jsonl`.
 */

import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createServer } from './server.js'
import { generateCapability } from './crypto.js'
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface CliOptions {
  file: string
  port: number
  host: string
  open: boolean
  local: boolean
}

/** Typed user-facing argument error (rendered as a one-line actionable error). */
export class CliArgumentError extends Error {}

const HELP = `
jsonlex - JSONL Explorer CLI

Usage:
  jsonlex <file> [options]
  jsonlex -- <file starting with a dash>

Options:
  -p, --port <n>      Port to bind (default: ephemeral)
  -h, --host <h>      Host to bind (default: 127.0.0.1)
  --no-open           Don't open browser automatically
  --local             Serve bundled static site locally (same-origin)
  --help              Show this help
  --version           Show version

Notes:
  --                  Ends option parsing; the next argument is the file
                      (for names starting with "-"). Duplicates: last wins.

Examples:
  jsonlex data.jsonl
  jsonlex data.jsonl --local
  jsonlex data.jsonl --port 8080 --no-open
`

const parseOptions = {
  port: { type: 'string' as const, short: 'p' },
  host: { type: 'string' as const, short: 'h' },
  'no-open': { type: 'boolean' as const },
  local: { type: 'boolean' as const },
  help: { type: 'boolean' as const },
  version: { type: 'boolean' as const },
}

/** Validates a positional file reference (existence + regular file). */
function resolveFile(positional: string): string {
  const resolved = resolve(positional)
  if (!existsSync(resolved)) {
    throw new CliArgumentError(`File not found: ${resolved}`)
  }
  if (!statSync(resolved).isFile()) {
    throw new CliArgumentError(`Not a regular file: ${resolved}`)
  }
  return resolved
}

/** Validates the --port value (1-65535, or 0 for ephemeral). */
function resolvePort(raw: string | undefined): number {
  if (!raw) return 0
  const port = Number.parseInt(raw, 10)
  if (raw.trim() === '' || Number.isNaN(port) || port < 1 || port > 65535 || String(port) !== raw.trim()) {
    throw new CliArgumentError(`Invalid port: ${raw} (expected an integer 1-65535)`)
  }
  return port
}

/** Typed view over parseArgs' values (single-value options only). */
interface ParsedValues {
  port?: string
  host?: string
  'no-open'?: boolean
  local?: boolean
  help?: boolean
  version?: boolean
}

/**
 * Parses CLI arguments (pure: no I/O beyond the file-existence checks).
 * Signals help/version via the returned flags; throws CliArgumentError
 * for any user-facing argument failure.
 */
export function parseCliArgs(
  argv: string[],
): { options: CliOptions; showHelp: boolean; showVersion: boolean } {
  let values: ParsedValues
  let positionals: string[]
  try {
    const parsed = parseArgs({ args: argv, options: parseOptions, allowPositionals: true })
    values = parsed.values as ParsedValues
    positionals = parsed.positionals
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code.startsWith('ERR_PARSE_ARGS')) {
      // Node's parseArgs messages are already user-facing ("Unknown
      // option '--bogus'", "Option '--port <value>' argument missing").
      throw new CliArgumentError(`${error instanceof Error ? error.message : String(error)} (see --help)`)
    }
    throw error
  }

  if (values.help) return { options: stubOptions(), showHelp: true, showVersion: false }
  if (values.version) return { options: stubOptions(), showHelp: false, showVersion: true }

  if (positionals.length === 0) {
    throw new CliArgumentError('Missing required argument <file>')
  }
  if (positionals.length > 1) {
    throw new CliArgumentError(`Expected exactly one <file> argument, got ${positionals.length}`)
  }

  const host = values.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost' && !values.local) {
    throw new CliArgumentError('Non-loopback host requires the --local flag (security)')
  }

  return {
    options: {
      file: resolveFile(positionals[0]!),
      port: resolvePort(values.port),
      host,
      open: !values['no-open'],
      local: values.local === true,
    },
    showHelp: false,
    showVersion: false,
  }
}

function stubOptions(): CliOptions {
  return { file: '', port: 0, host: '127.0.0.1', open: true, local: false }
}

export function printHelp(): void {
  console.log(HELP)
}

export function printVersion(): void {
  const pkgPath = join(__dirname, '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }
  console.log(pkg.version)
}

async function main(): Promise<void> {
  let parsed: { options: CliOptions; showHelp: boolean; showVersion: boolean }
  try {
    parsed = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof CliArgumentError) {
      console.error(`Error: ${error.message}`)
      process.exitCode = 1
      return
    }
    throw error
  }

  if (parsed.showHelp) {
    printHelp()
    return
  }
  if (parsed.showVersion) {
    printVersion()
    return
  }

  const options = parsed.options
  const capability = generateCapability()

  try {
    const server = await createServer({
      file: options.file,
      port: options.port,
      host: options.host,
      capability,
      local: options.local,
    })

    const address = server.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server address')
    }

    const baseUrl = `http://${address.address === '::' ? '127.0.0.1' : address.address}:${address.port}`
    const fileUrl = `${baseUrl}/${capability}/file.jsonl`
    const explorerUrl = options.local
      ? `${baseUrl}/?url=${encodeURIComponent(fileUrl)}`
      : `https://jsonlexplorer.lucasschirm.com/?url=${encodeURIComponent(fileUrl)}`

    console.log(`Server running at ${baseUrl}`)
    console.log(`File served at ${fileUrl.replace(capability, '[capability]')}`)
    console.log(`Opening: ${explorerUrl.replace(capability, '[capability]')}`)

    if (options.open) {
      const { default: open } = await import('open')
      await open(explorerUrl)
    }

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`\n${signal} received, shutting down...`)
      await server.close()
      process.exit(0)
    }

    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))

    await new Promise(() => {})
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

// Run main() only when executed as the CLI entry (not when imported by
// tests, which exercise parseCliArgs directly). realpath: bin links in
// node_modules/.bin are symlinks, while import.meta.url is the real path.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null
const isMain = invokedPath === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
