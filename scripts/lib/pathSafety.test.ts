import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertPathOutsideRepo, UnsafePathError } from './pathSafety.ts'

const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

describe('assertPathOutsideRepo — basic cases', () => {
  it('rejects a relative path', () => {
    expect(() => assertPathOutsideRepo('--report-path', 'relative/report.json', REPO_ROOT)).toThrow(UnsafePathError)
  })

  it('rejects a path that IS the repo root', () => {
    expect(() => assertPathOutsideRepo('--report-path', REPO_ROOT, REPO_ROOT)).toThrow(UnsafePathError)
  })

  it('rejects a path inside the repo (docs/)', () => {
    expect(() => assertPathOutsideRepo('--decisions-file', join(REPO_ROOT, 'docs', 'x.json'), REPO_ROOT)).toThrow(UnsafePathError)
  })

  it('rejects a path with .. segments that resolve back inside the repo', () => {
    const outsideLooking = join(REPO_ROOT, '..', REPO_ROOT.split(/[\\/]/).pop()!, 'docs', 'x.json')
    expect(() => assertPathOutsideRepo('--report-path', outsideLooking, REPO_ROOT)).toThrow(UnsafePathError)
  })

  it('accepts a genuinely external absolute path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec005-pathsafety-'))
    expect(() => assertPathOutsideRepo('--report-path', join(dir, 'report.json'), REPO_ROOT)).not.toThrow()
  })

  it('accepts an external path even when the file itself does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec005-pathsafety-'))
    const notYetCreated = join(dir, 'nested', 'does-not-exist-yet', 'report.json')
    expect(() => assertPathOutsideRepo('--report-path', notYetCreated, REPO_ROOT)).not.toThrow()
  })
})

describe('assertPathOutsideRepo — symlink resolution', () => {
  it('rejects a path reached through a symlinked ancestor directory that points back inside the repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec005-pathsafety-symlink-'))
    const linkPath = join(dir, 'link-to-repo')
    try {
      symlinkSync(REPO_ROOT, linkPath, 'junction')
    } catch {
      // Symlink creation can require elevated privileges on some Windows
      // configurations — skip this specific assertion there rather than
      // failing the whole suite for an environment limitation unrelated to
      // the logic under test.
      return
    }
    expect(() => assertPathOutsideRepo('--report-path', join(linkPath, 'docs', 'x.json'), REPO_ROOT)).toThrow(UnsafePathError)
  })
})

describe('assertPathOutsideRepo — Windows/macOS case-insensitivity', () => {
  it('rejects an upper-cased variant of a path inside the repo on case-insensitive platforms', () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return
    const upper = join(REPO_ROOT.toUpperCase(), 'docs', 'x.json')
    expect(() => assertPathOutsideRepo('--report-path', upper, REPO_ROOT)).toThrow(UnsafePathError)
  })
})

describe('assertPathOutsideRepo — nested existing directories still validate correctly', () => {
  it('accepts a path under an existing external directory tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec005-pathsafety-'))
    const nested = join(dir, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    expect(() => assertPathOutsideRepo('--report-path', join(nested, 'report.json'), REPO_ROOT)).not.toThrow()
  })
})
