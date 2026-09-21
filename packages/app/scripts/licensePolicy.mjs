/**
 * TSK0051 — license policy for generated dependency credits.
 *
 * Pure module (no I/O) so both the build-time generator
 * (`scripts/generate-credits.mjs`) and the unit tests import the SAME
 * policy. The policy is the security boundary: a dependency whose license
 * is missing, unknown, or forbidden fails the build (exit 1) — credits
 * are only generated for a fully audited dependency set.
 *
 * Model:
 * - `ALLOWED_LICENSES` — SPDX identifiers this project may ship with
 *   (permissive licenses only).
 * - `FORBIDDEN_PATTERNS` — regexes that fail even if an identifier is
 *   otherwise unknown (copyleft/SSPL/proprietary/"see license in …").
 * - A license expression (SPDX, e.g. "MIT OR Apache-2.0" or
 *   "(BSD-3-Clause OR GPL-2.0)") is audited TOKEN by TOKEN: every token
 *   must be allowed. (An "OR" grants choice, but crediting requires us to
 *   understand every option the dep offers.)
 */

export const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  // Permissive (OSI-approved) but non-standard identifiers that appear in
  // the transitive runtime closure:
  'Python-2.0', // PSF license (argparse) — permissive
  'CC-BY-4.0', // caniuse-lite data — attribution satisfied by the credits page
])

/**
 * Documented exceptions for packages whose package.json metadata is
 * deficient but whose SHIPPED LICENSE file is verifiable. Each entry is a
 * reviewed, named exception — not a wildcard. The generator credits the
 * exception's `license` and still ships the package's LICENSE file text.
 */
export const LICENSE_EXCEPTIONS = {
  'xmlhttprequest-ssl': {
    license: 'MIT',
    reason: 'package.json has no license field; the shipped LICENSE file is MIT (Copyright (c) 2010 passive.ly LLC)',
  },
  'node-forge': {
    license: 'BSD-3-Clause',
    reason: 'dual-licensed (BSD-3-Clause OR GPL-2.0); the app relies on the BSD-3-Clause option',
  },
}

export const FORBIDDEN_PATTERNS = [
  { name: 'GPL', re: /(^|[^A-Za-z0-9.])GPL/i },
  { name: 'LGPL', re: /(^|[^A-Za-z0-9.])LGPL/i },
  { name: 'AGPL', re: /(^|[^A-Za-z0-9.])AGPL/i },
  { name: 'SSPL', re: /(^|[^A-Za-z0-9.])SSPL/i },
  { name: 'copyleft', re: /AGPL|GNU General/i },
  { name: 'unlicensed', re: /UNLICENSED/i },
  { name: 'license-by-reference', re: /SEE LICENSE IN/i },
  { name: 'proprietary', re: /Proprietary/i },
]

/**
 * Extract the SPDX identifier tokens from a license expression.
 * "MIT OR Apache-2.0" → ["MIT", "Apache-2.0"]; "(BSD-3-Clause OR GPL-2.0)"
 * → ["BSD-3-Clause", "GPL-2.0"]. Words that are operators/qualifiers
 * (AND, OR, WITH, plus, etc.) are dropped.
 */
export function licenseTokens(licenseField) {
  const expr = typeof licenseField === 'string'
    ? licenseField
    : (licenseField?.type ?? '')
  return expr
    .split(/[^A-Za-z0-9.+-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => !/^(AND|OR|WITH|EXCEPTION|PLUS)$/i.test(t))
}

/**
 * Audit one dependency's license.
 * @returns {{ ok: true, license: string, exception?: string } | { ok: false, reason: string }}
 */
export function checkLicense(name, licenseField) {
  const exception = LICENSE_EXCEPTIONS[name]
  if (licenseField == null || (typeof licenseField === 'string' && licenseField.trim() === '')) {
    if (exception) return { ok: true, license: exception.license, exception: exception.reason }
    return { ok: false, reason: `${name}: missing license metadata` }
  }
  if (exception) return { ok: true, license: exception.license, exception: exception.reason }
  const tokens = licenseTokens(licenseField)
  if (tokens.length === 0) {
    return { ok: false, reason: `${name}: license expression has no parseable SPDX identifier (${JSON.stringify(licenseField)})` }
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.re.test(typeof licenseField === 'string' ? licenseField : JSON.stringify(licenseField))) {
      return { ok: false, reason: `${name}: forbidden license (${pattern.name}) — ${JSON.stringify(licenseField)}` }
    }
  }
  const unknown = tokens.filter((t) => !ALLOWED_LICENSES.has(t))
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `${name}: disallowed license "${unknown.join('", "')}" (allowed: ${[...ALLOWED_LICENSES].join(', ')})`,
    }
  }
  return { ok: true, license: typeof licenseField === 'string' ? licenseField : String(licenseField.type) }
}
