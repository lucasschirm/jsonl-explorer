/**
 * Fastify server for jsonlex CLI
 * Serves JSONL file with capability-based access control
 * and optionally the static explorer site (--local mode)
 */

import fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createReadStream, statSync } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface ServerOptions {
  file: string
  port: number
  host: string
  capability: string
  local: boolean
}

const HOSTED_ORIGIN = 'https://jsonlexplorer.lucasschirm.com'

function getSitePath(): string {
  // In production, site is bundled in package under 'site' directory
  // In development, use the app's generated output
  const pkgSite = resolve(__dirname, '..', 'site')
  const devSite = resolve(__dirname, '..', '..', 'app', '.output', 'public')
  return existsSync(pkgSite) ? pkgSite : devSite
}

function existsSync(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export async function createServer(options: ServerOptions) {
  const server = fastify({ logger: false })

  // Security headers
  server.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Cache-Control', 'no-store')
  })

  // CORS for file endpoint
  server.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin ?? ''
    const host = request.headers.host ?? ''

    // Only allow the exact hosted origin (or same-origin for --local)
    const allowedOrigin = options.local ? `http://${host}` : HOSTED_ORIGIN

    if (origin && origin !== allowedOrigin) {
      reply.code(403)
      return reply.send({ error: 'Forbidden: Invalid origin' })
    }

    // Validate Host header
    if (host && !host.startsWith('127.0.0.1') && !host.startsWith('localhost') && !host.startsWith('[::1]')) {
      reply.code(403)
      return reply.send({ error: 'Forbidden: Invalid host' })
    }

    // CORS headers
    reply.header('Access-Control-Allow-Origin', allowedOrigin)
    reply.header('Vary', 'Origin')
    reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Range, Content-Type')
    reply.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')

    // Private Network Access header for Chrome
    reply.header('Access-Control-Allow-Private-Network', 'true')

    // Handle preflight
    if (request.method === 'OPTIONS') {
      reply.code(204)
      return reply.send()
    }
  })

  // Capability-protected file endpoint
  const fileRoute = `/${options.capability}/file.jsonl`

  server.get(fileRoute, async (request, reply) => {
    // Verify capability in path
    if (request.url !== fileRoute && request.url !== `${fileRoute}/`) {
      reply.code(404)
      return reply.send({ error: 'Not found' })
    }

    const fileStat = statSync(options.file)
    const fileSize = fileStat.size

    // Range request support
    const range = request.headers.range
    let start = 0
    let end = fileSize - 1

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/)
      if (match && match[1]) {
        start = parseInt(match[1], 10)
        end = match[2] ? parseInt(match[2], 10) : fileSize - 1
        if (start >= fileSize || end >= fileSize || start > end) {
          reply.code(416)
          reply.header('Content-Range', `bytes */${fileSize}`)
          return reply.send()
        }
        reply.code(206)
        reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      }
    }

    reply.header('Content-Type', 'application/jsonl')
    reply.header('Content-Length', String(end - start + 1))
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Cache-Control', 'no-store')

    const stream = createReadStream(options.file, { start, end })
    return reply.send(stream)
  })

  server.head(fileRoute, async (request, reply) => {
    if (request.url !== fileRoute && request.url !== `${fileRoute}/`) {
      reply.code(404)
      return reply.send()
    }
    const fileStat = statSync(options.file)
    reply.header('Content-Type', 'application/jsonl')
    reply.header('Content-Length', String(fileStat.size))
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Cache-Control', 'no-store')
    return reply.send()
  })

  // Serve static site in --local mode
  if (options.local) {
    const sitePath = getSitePath()
    if (existsSync(sitePath)) {
      await server.register(fastifyStatic, {
        root: sitePath,
        prefix: '/',
        decorateReply: false,
      })
    } else {
      console.warn(`Warning: Static site not found at ${sitePath}`)
    }
  }

  // Health check
  server.get('/health', async () => ({ ok: true }))

  await server.listen({ port: options.port, host: options.host })
  return server
}