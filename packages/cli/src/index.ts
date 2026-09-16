#!/usr/bin/env node
/**
 * jsonlex - JSONL Explorer CLI
 *
 * Serves a JSONL file via a local Fastify server and opens the JSONL Explorer
 * in the browser with a capability-protected URL.
 */

import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createServer } from './server.js'
import { generateCapability } from './crypto.js'
import { readFileSync, existsSync, statSync } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface CliOptions {
  file: string
  port: number
  host: string
  open: boolean
  local: boolean
  help: boolean
  version: boolean
}

function parseCliArgs(): CliOptions {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'h' },
      'no-open': { type: 'boolean' },
      local: { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
    allowPositionals: true,
  })

  if (values.help) {
    printHelp()
    process.exit(0)
  }

  if (values.version) {
    printVersion()
    process.exit(0)
  }

  const file = positionals[0]
  if (!file) {
    console.error('Error: Missing required argument <file>')
    printHelp()
    process.exit(1)
  }

  const resolvedFile = resolve(file)
  if (!existsSync(resolvedFile)) {
    console.error(`Error: File not found: ${resolvedFile}`)
    process.exit(1)
  }

  const stats = statSync(resolvedFile)
  if (!stats.isFile()) {
    console.error(`Error: Not a regular file: ${resolvedFile}`)
    process.exit(1)
  }

  const port = values.port ? parseInt(values.port, 10) : 0
  if (values.port && (isNaN(port) || port < 1 || port > 65535)) {
    console.error('Error: Invalid port number (1-65535)')
    process.exit(1)
  }

  const host = values.host || '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost' && !values.local) {
    console.error('Error: Non-loopback host requires --local flag for security')
    process.exit(1)
  }

  return {
    file: resolvedFile,
    port,
    host,
    open: !values['no-open'],
    local: values.local || false,
    help: false,
    version: false,
  }
}

function printHelp() {
  console.log(`
jsonlex - JSONL Explorer CLI

Usage:
  jsonlex <file> [options]

Options:
  -p, --port <n>      Port to bind (default: ephemeral)
  -h, --host <h>      Host to bind (default: 127.0.0.1)
  --no-open           Don't open browser automatically
  --local             Serve bundled static site locally (same-origin)
  --help              Show this help
  --version           Show version

Examples:
  jsonlex data.jsonl
  jsonlex data.jsonl --local
  jsonlex data.jsonl --port 8080 --no-open
`)
}

function printVersion() {
  const pkgPath = join(__dirname, '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  console.log(pkg.version)
}

async function main() {
  const options = parseCliArgs()
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

    // Handle shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received, shutting down...`)
      await server.close()
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    // Keep process alive
    await new Promise(() => {})
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

main()