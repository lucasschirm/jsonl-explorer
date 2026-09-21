import { describe, it, expect } from 'vitest'
import { buildAppCsp, frameAncestors, APP_SECURITY_HEADERS } from '../src/csp.js'

describe('frameAncestors', () => {
  it('defaults to same-origin only', () => {
    expect(frameAncestors()).toBe("'self'")
    expect(frameAncestors('')).toBe("'self'")
  })

  it('adds allowlisted origins, trimmed', () => {
    expect(frameAncestors('https://a.example')).toBe("'self' https://a.example")
    expect(frameAncestors(' https://a.example , https://b.example ')).toBe(
      "'self' https://a.example https://b.example",
    )
  })

  it('drops "*" (fail closed) and the invalid "same-origin" token', () => {
    expect(frameAncestors('*')).toBe("'self'")
    expect(frameAncestors('same-origin')).toBe("'self'")
    expect(frameAncestors('* https://a.example same-origin')).toBe("'self' https://a.example")
  })

  it('drops blank entries', () => {
    expect(frameAncestors(',,')).toBe("'self'")
    expect(frameAncestors(' , https://a.example ')).toBe("'self' https://a.example")
  })
})

describe('buildAppCsp', () => {
  it('carries the directives the app needs', () => {
    const csp = buildAppCsp()
    for (const directive of [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
      "worker-src 'self' blob:",
      "connect-src 'self' https:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ]) {
      expect(csp).toContain(directive)
    }
  })

  it('honors the handover allowlist in frame-ancestors', () => {
    expect(buildAppCsp('https://host.example')).toContain(
      "frame-ancestors 'self' https://host.example",
    )
  })

  it('is a single semicolon-joined string (HTTP-header ready)', () => {
    expect(buildAppCsp()).not.toMatch(/\n/)
    expect(buildAppCsp().split('; ').length).toBeGreaterThan(5)
  })
})

describe('APP_SECURITY_HEADERS', () => {
  it('ships nosniff + no-referrer on every serving surface', () => {
    expect(APP_SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff')
    expect(APP_SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer')
  })
})
