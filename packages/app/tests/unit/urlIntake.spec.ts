import { describe, it, expect } from 'vitest'
import {
  decideHeaderRow,
  decideUrlInput,
  FORBIDDEN_HEADER_NAMES,
} from '~/utils/urlIntake'

describe('decideUrlInput', () => {
  it('accepts and normalizes a plain http(s) URL', () => {
    const intake = decideUrlInput('https://Example.com/data.jsonl')
    expect(intake).toEqual({ kind: 'ready', url: 'https://example.com/data.jsonl' })
  })

  it('trims surrounding whitespace and preserves the query string', () => {
    const intake = decideUrlInput('  https://example.com/a.jsonl?x=1&y=2  ')
    expect(intake).toEqual({ kind: 'ready', url: 'https://example.com/a.jsonl?x=1&y=2' })
  })

  it('normalizes the default https port away', () => {
    const intake = decideUrlInput('https://example.com:443/a.jsonl')
    expect(intake).toEqual({ kind: 'ready', url: 'https://example.com/a.jsonl' })
  })

  it('reports empty input distinctly (not an error message)', () => {
    expect(decideUrlInput('')).toEqual({ kind: 'empty' })
    expect(decideUrlInput('   ')).toEqual({ kind: 'empty' })
  })

  it.each([
    ['ftp://example.com/a.jsonl', 'Only HTTP and HTTPS URLs are supported'],
    ['file:///tmp/a.jsonl', 'Only HTTP and HTTPS URLs are supported'],
    ['javascript:alert(1)', 'Only HTTP and HTTPS URLs are supported'],
  ])('rejects non-http(s) scheme %s', (input, message) => {
    expect(decideUrlInput(input)).toEqual({ kind: 'invalid', message })
  })

  it.each([
    ['https://user:pass@example.com/a.jsonl'],
    ['https://user@example.com/a.jsonl'],
    ['https://:pass@example.com/a.jsonl'],
  ])('rejects embedded credentials in %s', (input) => {
    const intake = decideUrlInput(input)
    expect(intake.kind).toBe('invalid')
    if (intake.kind === 'invalid') {
      expect(intake.message).toContain('embedded credentials')
      // The actionable message never echoes the credential material.
      expect(intake.message).not.toContain('user')
      expect(intake.message).not.toContain('pass')
    }
  })

  it('rejects fragments', () => {
    const intake = decideUrlInput('https://example.com/a.jsonl#section')
    expect(intake).toMatchObject({ kind: 'invalid', message: expect.stringContaining('fragment') })
  })

  it('rejects unparseable input', () => {
    expect(decideUrlInput('not a url')).toEqual({ kind: 'invalid', message: 'Invalid URL format' })
    expect(decideUrlInput('https://')).toEqual({ kind: 'invalid', message: 'Invalid URL format' })
  })
})

describe('decideHeaderRow', () => {
  const seen = () => new Set<string>()

  it('skips blank starter rows', () => {
    expect(decideHeaderRow('', '', seen())).toEqual({ kind: 'skip' })
    expect(decideHeaderRow('  ', '  ', seen())).toEqual({ kind: 'skip' })
  })

  it('requires a name when a value is present', () => {
    const intake = decideHeaderRow('', 'some value', seen())
    expect(intake).toMatchObject({ kind: 'invalid', message: 'Header name cannot be empty' })
  })

  it('accepts a valid row with an empty value', () => {
    const intake = decideHeaderRow('X-Custom', '', seen())
    expect(intake).toEqual({ kind: 'ready', name: 'X-Custom', value: '', credentialLike: false })
  })

  it('trims name and value', () => {
    const intake = decideHeaderRow('  x-custom  ', '  value  ', seen())
    expect(intake).toMatchObject({ kind: 'ready', name: 'x-custom', value: 'value' })
  })

  it('rejects names outside the HTTP token charset', () => {
    const intake = decideHeaderRow('X Bad Name', 'v', seen())
    expect(intake).toMatchObject({ kind: 'invalid', message: expect.stringContaining('not a valid HTTP header name') })
  })

  it.each(['Host', 'Cookie', 'User-Agent', 'Referer', 'Content-Length'])(
    'rejects the browser-forbidden header %s',
    (name) => {
      const intake = decideHeaderRow(name, 'v', seen())
      expect(intake).toMatchObject({
        kind: 'invalid',
        message: expect.stringContaining('forbidden by the browser'),
      })
      expect(FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())).toBe(true)
    },
  )

  it('rejects line breaks in name and value (CRLF injection)', () => {
    expect(decideHeaderRow('X-Ok', 'a\r\nX-Injected: 1', seen())).toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('line breaks'),
    })
    expect(decideHeaderRow('X-Ok', 'a\nX-Injected: 1', seen())).toMatchObject({
      kind: 'invalid',
    })
    expect(decideHeaderRow('X-Ok', 'a\rb', seen())).toMatchObject({ kind: 'invalid' })
  })

  it('enforces length caps', () => {
    const longName = `X-${'a'.repeat(256)}`
    expect(decideHeaderRow(longName, 'v', seen())).toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('too long'),
    })
    const longValue = 'v'.repeat(4097)
    expect(decideHeaderRow('X-Ok', longValue, seen())).toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('too long'),
    })
    // Exact caps are allowed.
    expect(decideHeaderRow(`X-${'a'.repeat(253)}`, 'v'.repeat(4096), seen()).kind).toBe('ready')
  })

  it('rejects duplicates case-insensitively', () => {
    const s = seen()
    expect(decideHeaderRow('X-Api-Key', 'a', s).kind).toBe('ready')
    const dup = decideHeaderRow('x-api-key', 'b', s)
    expect(dup).toMatchObject({ kind: 'invalid', message: 'Duplicate header: x-api-key' })
  })

  it.each([
    ['Authorization', true],
    ['authorization', true],
    ['Proxy-Authorization', true],
    ['X-Api-Key', true],
    ['API-KEY', true],
    ['X-Auth-Token', true],
    ['X-Access-Token', true],
    ['X-Session-Token', true],
    ['Token', true],
    ['X-Custom', false],
    ['Accept', false],
  ])('marks %s as credential-like: %s', (name, credentialLike) => {
    const intake = decideHeaderRow(name, 'secret-value', seen())
    expect(intake.kind).toBe('ready')
    if (intake.kind === 'ready') {
      expect(intake.credentialLike).toBe(credentialLike)
      // The value never leaks into the decision result beyond the row itself.
    }
  })
})
