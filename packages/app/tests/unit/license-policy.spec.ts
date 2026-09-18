import { describe, expect, it } from 'vitest'
import {
  ALLOWED_LICENSES,
  checkLicense,
  licenseTokens,
} from '../../scripts/licensePolicy.mjs'

describe('license policy (TSK0051)', () => {
  describe('licenseTokens', () => {
    it('extracts simple identifiers', () => {
      expect(licenseTokens('MIT')).toEqual(['MIT'])
    })
    it('splits OR/AND expressions and drops operators', () => {
      expect(licenseTokens('MIT OR Apache-2.0')).toEqual(['MIT', 'Apache-2.0'])
      expect(licenseTokens('(BSD-3-Clause OR GPL-2.0) WITH LicenseRef-foo')).toEqual([
        'BSD-3-Clause',
        'GPL-2.0',
        'LicenseRef-foo',
      ])
    })
    it('handles object license fields and junk', () => {
      expect(licenseTokens({ type: 'ISC' })).toEqual(['ISC'])
      expect(licenseTokens(null)).toEqual([])
      expect(licenseTokens('')).toEqual([])
    })
  })

  describe('checkLicense', () => {
    it('accepts every allowed license', () => {
      for (const license of ALLOWED_LICENSES) {
        const result = checkLicense('some-pkg', license)
        expect(result.ok, `${license} should be allowed`).toBe(true)
      }
    })
    it('accepts an OR-expression when every option is allowed', () => {
      expect(checkLicense('pkg', '(MIT OR CC0-1.0)').ok).toBe(true)
    })
    it('fails on missing metadata', () => {
      for (const missing of [undefined, null, '', '   ']) {
        const result = checkLicense('pkg', missing)
        expect(result.ok).toBe(false)
        expect((result as { reason: string }).reason).toContain('missing license')
      }
    })
    it('fails on copyleft even inside an OR (the GPL option is disallowed)', () => {
      const result = checkLicense('pkg', '(BSD-3-Clause OR GPL-2.0)')
      expect(result.ok).toBe(false)
      expect((result as { reason: string }).reason).toContain('forbidden')
    })
    it('fails on unknown licenses and says what is allowed', () => {
      const result = checkLicense('pkg', 'XYZ-1.0')
      expect(result.ok).toBe(false)
      const reason = (result as { reason: string }).reason
      expect(reason).toContain('disallowed')
      expect(reason).toContain('MIT')
    })
    it('fails on unlicensed / see-license-in references', () => {
      expect(checkLicense('pkg', 'UNLICENSED').ok).toBe(false)
      expect(checkLicense('pkg', 'SEE LICENSE IN LICENSE-MIT.txt').ok).toBe(false)
    })
    it('applies documented exceptions for metadata-deficient packages', () => {
      // package.json has no license field, but the shipped LICENSE file is MIT.
      const result = checkLicense('xmlhttprequest-ssl', undefined)
      expect(result.ok).toBe(true)
      expect((result as { license: string }).license).toBe('MIT')
      expect((result as { exception: string }).exception).toBeTruthy()
    })
    it('reports the package name in every failure', () => {
      const result = checkLicense('the-offending-pkg', 'AGPL-3.0')
      expect(result.ok).toBe(false)
      expect((result as { reason: string }).reason).toContain('the-offending-pkg')
    })
  })
})
