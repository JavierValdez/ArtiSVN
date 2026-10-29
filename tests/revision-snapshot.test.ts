import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'
import {
  buildRevisionUrl,
  normalizeRepoScopedSvnPath,
  readRevisionSnapshot,
  type SnapshotDeps
} from '../src/main/services/revision-snapshot'

const hasSvn = spawnSync('svn', ['--version', '--quiet']).status === 0 && spawnSync('svnadmin', ['--version', '--quiet']).status === 0

function svn(args: string[], cwd?: string): Buffer {
  const result = spawnSync('svn', ['--non-interactive', ...args], { cwd })
  if (result.status !== 0) throw new Error(String(result.stderr))
  return result.stdout
}

// Real svn CLI behind the injected dependencies (same commands as read-ops).
const deps: SnapshotDeps = {
  async readKind(pegUrl) {
    return svn(['info', '--show-item', 'kind', '--no-newline', '--', pegUrl]).toString().trim() === 'dir' ? 'dir' : 'file'
  },
  async readBytes(pegUrl, maxBytes) {
    const out = svn(['cat', '--', pegUrl])
    return out.length > maxBytes ? { buffer: out.subarray(0, maxBytes), truncated: true } : { buffer: out, truncated: false }
  }
}

const TRICKY_DIR = 'carpeta con espacios'
const TRICKY_FILE = 'a b@c #50%ñ.txt'
const TRICKY_PATH = `/${TRICKY_DIR}/${TRICKY_FILE}`

describe('historical file snapshot (integration with svnadmin)', { skip: !hasSvn && 'svn/svnadmin no disponibles' }, () => {
  let root = ''
  let url = ''
  let wc = ''
  const rev: Record<string, number> = {}

  const commit = (message: string): number => {
    svn(['commit', '-m', message], wc)
    svn(['update'], wc)
    return Number(svn(['info', '--show-item', 'revision', '--no-newline'], wc).toString())
  }

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'artisvn-snapshot-')))
    spawnSync('svnadmin', ['create', join(root, 'repo')])
    url = pathToFileURL(join(root, 'repo')).href
    wc = join(root, 'wc')
    svn(['checkout', url, wc])

    mkdirSync(join(wc, TRICKY_DIR))
    writeFileSync(join(wc, TRICKY_DIR, TRICKY_FILE), 'contenido r1\n')
    writeFileSync(join(wc, 'vacio.txt'), '')
    writeFileSync(join(wc, 'binario.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0xff, 0x00]))
    writeFileSync(join(wc, 'latin1.txt'), Buffer.from('Año café\n', 'latin1'))
    writeFileSync(join(wc, 'grande.txt'), `${'ñ'.repeat(600)}\nfin\n`)
    svn(['add', TRICKY_DIR, 'vacio.txt', 'binario.dat', 'latin1.txt', 'grande.txt'], wc)
    rev.r1 = commit('r1')

    writeFileSync(join(wc, TRICKY_DIR, TRICKY_FILE), 'contenido r2\n  con   espacios\tpreservados\n')
    rev.r2 = commit('r2')

    // Renamed and then the new name deleted: the old path no longer exists at HEAD.
    svn(['move', `${TRICKY_DIR}/${TRICKY_FILE}@`, `${TRICKY_DIR}/renombrado.txt`], wc)
    rev.r3 = commit('rename')
    svn(['delete', `${TRICKY_DIR}/renombrado.txt`], wc)
    rev.r4 = commit('delete')
  })

  after(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  test('reads the exact content of each old revision, not HEAD, for names with spaces, @, # and %', async () => {
    const r1 = await readRevisionSnapshot(url, TRICKY_PATH, rev.r1, deps)
    const r2 = await readRevisionSnapshot(url, TRICKY_PATH, rev.r2, deps)
    assert.equal(r1.kind, 'text')
    assert.equal(r2.kind, 'text')
    assert.equal((r1 as any).text, 'contenido r1\n')
    assert.equal((r2 as any).text, 'contenido r2\n  con   espacios\tpreservados\n')
    assert.equal((r2 as any).truncated, false)
    // The path is gone at HEAD (renamed + deleted): a HEAD read must fail.
    assert.throws(() => svn(['cat', '--', buildRevisionUrl(url, TRICKY_PATH, rev.r4)]))
  })

  test('a missing path at the requested revision is an error, not empty text', async () => {
    await assert.rejects(readRevisionSnapshot(url, `/${TRICKY_DIR}/renombrado.txt`, rev.r2, deps))
  })

  test('folders, binaries, empty and non UTF-8 files are classified explicitly', async () => {
    assert.equal((await readRevisionSnapshot(url, `/${TRICKY_DIR}`, rev.r1, deps)).kind, 'dir')
    assert.equal((await readRevisionSnapshot(url, '/binario.dat', rev.r1, deps)).kind, 'binary')
    const empty = await readRevisionSnapshot(url, '/vacio.txt', rev.r1, deps)
    assert.deepEqual([empty.kind, (empty as any).text], ['text', ''])
    const latin1 = await readRevisionSnapshot(url, '/latin1.txt', rev.r1, deps)
    assert.deepEqual([(latin1 as any).encoding, (latin1 as any).text], ['latin1', 'Año café\n'])
  })

  test('byte cap truncates without breaking a multi-byte character', async () => {
    const capped = await readRevisionSnapshot(url, '/grande.txt', rev.r1, deps, 101) // 101 bytes = 50 "ñ" + half
    assert.equal(capped.kind, 'text')
    assert.equal((capped as any).truncated, true)
    assert.equal((capped as any).bytes, 101)
    assert.equal((capped as any).encoding, 'utf-8')
    assert.equal((capped as any).text, 'ñ'.repeat(50))
  })

  test('the revision diff URL stays valid after the file was renamed/deleted', () => {
    const diff = svn(['diff', `-c${rev.r2}`, '--', buildRevisionUrl(url, TRICKY_PATH, rev.r2)]).toString()
    assert.match(diff, /^-contenido r1$/m)
    assert.match(diff, /^\+contenido r2$/m)
  })
})

test('svn paths reject traversal and control characters', () => {
  assert.throws(() => normalizeRepoScopedSvnPath('/trunk/../secret'), /inválida/)
  assert.throws(() => normalizeRepoScopedSvnPath('trunk/a'), /comenzar/)
  assert.throws(() => normalizeRepoScopedSvnPath('/a\nb'), /inválida/)
  assert.equal(buildRevisionUrl('https://h/svn/repo/', '/a b/c@d.txt', 7), 'https://h/svn/repo/a%20b/c%40d.txt@7')
  assert.throws(() => buildRevisionUrl('https://h/r', '/a', 0), /entero positivo/)
})
