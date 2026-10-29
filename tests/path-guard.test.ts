import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  assertManagedRepoPath,
  isLexicallyInside,
  isPhysicallyInsideAny,
  readFileBounded,
  resolvePhysicalRepoTarget
} from '../src/main/services/path-guard'
import { resolveRepoRelativeTarget } from '../src/main/services/read-contract'

// Only marker files created by the test are read; no user files are touched.
const MARKER = 'MARCADOR_FUERA_DEL_REPOSITORIO'

describe('physical path isolation', () => {
  let root = ''
  let base = ''
  let repo = ''
  let outside = ''

  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'artisvn-paths-')))
    base = join(root, 'ArtiSVN')
    repo = join(base, 'repo')
    outside = join(root, 'outside')
    mkdirSync(join(repo, '.svn'), { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'marker.txt'), MARKER)
    writeFileSync(join(repo, 'src', 'ok.txt'), 'dentro')
    writeFileSync(join(repo, '..foo'), 'nombre válido')
    symlinkSync(join(outside, 'marker.txt'), join(repo, 'enlace.txt'))
    symlinkSync(outside, join(repo, 'enlace-dir'))
    symlinkSync(join(repo, 'src', 'ok.txt'), join(repo, 'enlace-interno.txt'))
    symlinkSync(join(root, 'no-existe'), join(repo, 'roto.txt'))
    symlinkSync(repo, join(base, 'repo-link'))
  })

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('segment-based lexical containment accepts "..foo" and rejects ".."', () => {
    assert.equal(isLexicallyInside(repo, join(repo, '..foo')), true)
    assert.equal(isLexicallyInside(repo, join(repo, '..', 'x')), false)
    assert.equal(isLexicallyInside(repo, repo), true)
    assert.doesNotThrow(() => resolveRepoRelativeTarget(repo, '..foo'))
    assert.throws(() => resolveRepoRelativeTarget(repo, '../x'), /fuera del repositorio/)
  })

  test('a symlink to a file outside the repo is rejected for reads', () => {
    assert.throws(() => resolvePhysicalRepoTarget(repo, 'enlace.txt'), /fuera del repositorio/)
  })

  test('a path through a symlinked directory outside the repo is rejected, even for SVN operations', () => {
    assert.throws(() => resolvePhysicalRepoTarget(repo, 'enlace-dir/marker.txt'), /fuera del repositorio/)
    assert.throws(
      () => resolvePhysicalRepoTarget(repo, 'enlace-dir/marker.txt', { allowSymlinkLeaf: true }),
      /fuera del repositorio/
    )
    assert.throws(() => resolvePhysicalRepoTarget(repo, 'enlace-dir/nuevo.txt'), /fuera del repositorio/)
  })

  test('SVN operations may target the symlink itself (svn does not follow it)', () => {
    const target = resolvePhysicalRepoTarget(repo, 'enlace.txt', { allowSymlinkLeaf: true })
    assert.equal(target.targetReal, join(realpathSync.native(repo), 'enlace.txt'))
  })

  test('symlinks that stay inside the repo and "..foo" files are allowed', () => {
    const inside = resolvePhysicalRepoTarget(repo, 'enlace-interno.txt')
    assert.equal(inside.targetReal, join(realpathSync.native(repo), 'src', 'ok.txt'))
    assert.equal(resolvePhysicalRepoTarget(repo, '..foo').exists, true)
  })

  test('broken symlinks and missing files are resolved through the nearest existing ancestor', () => {
    assert.throws(() => resolvePhysicalRepoTarget(repo, 'roto.txt'), /fuera del repositorio/)
    const missing = resolvePhysicalRepoTarget(repo, 'src/nuevo/archivo.txt')
    assert.equal(missing.exists, false)
  })

  test('bounded reads never return more than the limit', () => {
    const big = join(repo, 'src', 'big.txt')
    writeFileSync(big, 'x'.repeat(10_000))
    const read = readFileBounded(big, 100)
    assert.equal(read.buffer.length, 100)
    assert.equal(read.size, 10_000)
    assert.equal(read.truncated, true)
  })

  test('managed repo paths must be real direct children with .svn', () => {
    assert.equal(assertManagedRepoPath(repo, base), repo)
    assert.throws(() => assertManagedRepoPath(join(base, 'repo-link'), base), /carpeta real/)
    assert.throws(() => assertManagedRepoPath(join(repo, 'src'), base), /fuera del directorio/)
    assert.throws(() => assertManagedRepoPath(outside, base), /fuera del directorio/)
  })

  test('physical containment in allowed roots resolves symlinks', () => {
    assert.equal(isPhysicallyInsideAny(join(repo, 'src'), [base]), true)
    assert.equal(isPhysicallyInsideAny(join(repo, 'enlace-dir'), [base]), false)
  })
})
