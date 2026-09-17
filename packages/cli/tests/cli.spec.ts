import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCliArgs, CliArgumentError } from '../src/index.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jsonlex-cli-'))
  file = join(dir, 'data.jsonl')
  writeFileSync(file, '{"a":1}\n')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function expectCliError(argv: string[], fragment: string): void {
  try {
    parseCliArgs(argv)
    expect.unreachable(`expected CliArgumentError for: ${argv.join(' ')}`)
  } catch (error) {
    expect(error).toBeInstanceOf(CliArgumentError)
    expect((error as Error).message).toContain(fragment)
  }
}

describe('parseCliArgs — happy paths', () => {
  it('parses a bare file', () => {
    const { options, showHelp, showVersion } = parseCliArgs([file])
    expect(options.file).toBe(file)
    expect(options.port).toBe(0)
    expect(options.host).toBe('127.0.0.1')
    expect(options.open).toBe(true)
    expect(options.local).toBe(false)
    expect(showHelp).toBe(false)
    expect(showVersion).toBe(false)
  })

  it('parses all options', () => {
    const { options } = parseCliArgs([file, '-p', '8080', '-h', 'localhost', '--no-open', '--local'])
    expect(options.port).toBe(8080)
    expect(options.host).toBe('localhost')
    expect(options.open).toBe(false)
    expect(options.local).toBe(true)
  })

  it('--help wins over a missing file', () => {
    const { showHelp } = parseCliArgs(['--help'])
    expect(showHelp).toBe(true)
  })

  it('--version wins over a missing file', () => {
    const { showVersion } = parseCliArgs(['--version'])
    expect(showVersion).toBe(true)
  })

  it('accepts localhost without --local', () => {
    const { options } = parseCliArgs([file, '--host', 'localhost'])
    expect(options.host).toBe('localhost')
  })
})

describe('parseCliArgs — file handling', () => {
  it('rejects a missing file argument', () => {
    expectCliError([], 'Missing required argument <file>')
  })

  it('rejects a nonexistent file', () => {
    expectCliError([join(dir, 'nope.jsonl')], 'File not found')
  })

  it('rejects a directory', () => {
    expectCliError([dir], 'Not a regular file')
  })

  it('rejects extra positionals', () => {
    expectCliError([file, file], 'Expected exactly one <file> argument, got 2')
  })

  it('supports -- for dash-prefixed file names', () => {
    const dashy = join(dir, '-weird.jsonl')
    writeFileSync(dashy, '{"a":1}\n')
    const { options } = parseCliArgs(['--', dashy])
    expect(options.file).toBe(dashy)
  })
})

describe('parseCliArgs — port and host', () => {
  it.each(['abc', '0', '70000', '12x'])('rejects invalid port %s', (port) => {
    expectCliError([file, '--port', port], 'Invalid port')
  })

  // A dash-prefixed port value is read by parseArgs as a missing value
  // (it looks like a flag): still a typed, actionable error.
  it('rejects a dash-prefixed port as a malformed option', () => {
    expectCliError([file, '--port', '-5'], 'see --help')
  })

  it('rejects a non-loopback host without --local', () => {
    expectCliError([file, '--host', '0.0.0.0'], 'Non-loopback host requires the --local flag')
  })

  it('accepts a non-loopback host with --local', () => {
    const { options } = parseCliArgs([file, '--host', '0.0.0.0', '--local'])
    expect(options.host).toBe('0.0.0.0')
    expect(options.local).toBe(true)
  })
})

describe('parseCliArgs — unknown / duplicate / malformed options', () => {
  it('rejects an unknown long option with an actionable error', () => {
    expectCliError([file, '--bogus'], "Unknown option '--bogus'")
  })

  it('rejects an unknown short option', () => {
    expectCliError([file, '-x'], "Unknown option '-x'")
  })

  it('rejects an option missing its value', () => {
    expectCliError([file, '--port'], 'argument missing')
  })

  it('duplicate options: last occurrence wins', () => {
    const { options } = parseCliArgs([file, '-p', '1000', '--port', '2000', '-h', 'localhost', '--host', '127.0.0.1', '--local', '--local'])
    expect(options.port).toBe(2000)
    expect(options.host).toBe('127.0.0.1')
    expect(options.local).toBe(true)
  })
})

describe('parseCliArgs — purity', () => {
  it('throws (never exits) on typed errors, leaving exitCode untouched', () => {
    // Parsing is pure: a bad file must throw, which is what makes it
    // unit-testable and keeps main() the only process-exit site.
    expect(() => parseCliArgs([join(dir, 'missing.jsonl')])).toThrow(CliArgumentError)
    expect(process.exitCode).toBeUndefined()
  })
})
