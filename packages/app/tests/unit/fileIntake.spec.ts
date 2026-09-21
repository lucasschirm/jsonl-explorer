import { describe, it, expect } from 'vitest'
import {
  extensionOf,
  isUnusualExtension,
  decideFilePick,
  decideDrop,
  KNOWN_TEXT_EXTENSIONS,
} from '~/utils/fileIntake'

function file(name: string, size: number): File {
  return new File([size > 0 ? 'x'.repeat(size) : ''], name)
}

describe('extensionOf / isUnusualExtension', () => {
  it('extracts a lowercased extension including the dot', () => {
    expect(extensionOf('data.jsonl')).toBe('.jsonl')
    expect(extensionOf('DATA.JSONL')).toBe('.jsonl')
    expect(extensionOf('a.b.ndjson')).toBe('.ndjson')
  })

  it('treats names without a dot (and bare dotfiles) as extensionless', () => {
    expect(extensionOf('README')).toBe('')
    expect(extensionOf('.env')).toBe('')
    expect(extensionOf('')).toBe('')
  })

  it('warns only for extensions that are present and unrecognized', () => {
    for (const ext of KNOWN_TEXT_EXTENSIONS) {
      expect(isUnusualExtension(`f${ext}`)).toBe(false)
    }
    expect(isUnusualExtension('f.xyz')).toBe(true)
    expect(isUnusualExtension('README')).toBe(false) // no extension: content decides
  })
})

describe('decideFilePick', () => {
  it('returns none for an empty selection', () => {
    expect(decideFilePick([])).toEqual({ kind: 'none' })
  })

  it('opens a single valid file without notices', () => {
    const intake = decideFilePick([file('data.jsonl', 10)])
    expect(intake.kind).toBe('ready')
    if (intake.kind === 'ready') {
      expect(intake.file.name).toBe('data.jsonl')
      expect(intake.notices).toEqual([])
    }
  })

  it('uses the first of multiple files with a warning', () => {
    const first = file('first.jsonl', 10)
    const intake = decideFilePick([first, file('second.jsonl', 20)])
    expect(intake.kind).toBe('ready')
    if (intake.kind === 'ready') {
      expect(intake.file).toBe(first)
      expect(intake.notices).toHaveLength(1)
      expect(intake.notices[0]).toMatchObject({ kind: 'warning', message: expect.stringContaining('first one') })
    }
  })

  it('rejects zero-byte files', () => {
    const intake = decideFilePick([file('empty.jsonl', 0)])
    expect(intake.kind).toBe('reject-empty')
    if (intake.kind === 'reject-empty') {
      expect(intake.file.name).toBe('empty.jsonl')
      expect(intake.notice.message).toMatch(/empty/i)
    }
  })

  it('warns on unusual extensions but still opens', () => {
    const intake = decideFilePick([file('weird.xyz', 5)])
    expect(intake.kind).toBe('ready')
    if (intake.kind === 'ready') {
      expect(intake.notices).toHaveLength(1)
      expect(intake.notices[0]).toMatchObject({ kind: 'warning', message: expect.stringContaining('.xyz') })
    }
  })
})

describe('decideDrop', () => {
  it('classifies directory entries via webkitGetAsEntry', () => {
    const items = [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }) },
    ] as unknown as DataTransferItem[]
    expect(decideDrop(items, [])).toEqual({ kind: 'directory' })
  })

  it('classifies drops with no file entries as non-file (text/links)', () => {
    const items = [{ kind: 'string' }] as unknown as DataTransferItem[]
    expect(decideDrop(items, [])).toEqual({ kind: 'non-file' })
    expect(decideDrop(null, [])).toEqual({ kind: 'non-file' })
    expect(decideDrop(null, null)).toEqual({ kind: 'non-file' })
  })

  it('returns the file list for plain file drops', () => {
    const files = [file('a.jsonl', 1), file('b.jsonl', 2)]
    const intake = decideDrop(null, files)
    expect(intake.kind).toBe('files')
    if (intake.kind === 'files') expect(intake.files).toEqual(files)
  })

  it('ignores non-file items when file entries are present', () => {
    const files = [file('a.jsonl', 1)]
    const items = [
      { kind: 'string' },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) },
    ] as unknown as DataTransferItem[]
    const intake = decideDrop(items, files)
    expect(intake.kind).toBe('files')
  })
})
