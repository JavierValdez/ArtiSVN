import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'
import {
  commitSelectedPaths,
  normalizeSelection,
  parseStatusXml,
  planStrictCommit,
  revertSelectedPaths,
  type SvnRunner
} from '../src/main/services/commit'

function hasSvnTools(): boolean {
  const svn = spawnSync('svn', ['--version', '--quiet'])
  const admin = spawnSync('svnadmin', ['--version', '--quiet'])
  return svn.status === 0 && admin.status === 0
}

const SKIP = !hasSvnTools() && 'svn/svnadmin no disponibles'

function svn(args: string[], cwd?: string): string {
  const result = spawnSync('svn', [...args, '--non-interactive'], { cwd, encoding: 'utf-8' })
  if (result.status !== 0) throw new Error(`svn ${args.join(' ')} → ${result.stderr}`)
  return result.stdout
}

const run: SvnRunner = async (args, options) => {
  const result = spawnSync('svn', [...args, '--non-interactive'], { cwd: options.cwd, encoding: 'utf-8' })
  if (result.status !== 0) throw new Error(result.stderr || `svn exited ${result.status}`)
  return { stdout: result.stdout, stderr: result.stderr }
}

let root = ''
let repoUrl = ''

function freshWc(name: string): string {
  const wc = join(root, name)
  svn(['checkout', repoUrl, wc])
  return wc
}

function remoteTree(): string[] {
  return svn(['list', '-R', repoUrl]).split('\n').map((line) => line.trim()).filter(Boolean).sort()
}

function localStatus(wc: string): Record<string, string> {
  const out = svn(['status'], wc)
  const result: Record<string, string> = {}
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    result[line.slice(8).trim().replace(/\\/g, '/')] = line.slice(0, 7).trimEnd()
  }
  return result
}

describe('strict commit service (integration with svnadmin)', { skip: SKIP }, () => {
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'artisvn-commit-')))
    const repoDir = join(root, 'repo')
    const result = spawnSync('svnadmin', ['create', repoDir])
    assert.equal(result.status, 0)
    repoUrl = pathToFileURL(repoDir).href
    const seed = join(root, 'seed')
    svn(['checkout', repoUrl, seed])
    mkdirSync(join(seed, 'dir'))
    writeFileSync(join(seed, 'dir', 'x.txt'), 'x1\n')
    writeFileSync(join(seed, 'dir', 'y.txt'), 'y1\n')
    mkdirSync(join(seed, 'old'))
    writeFileSync(join(seed, 'old', 'gone.txt'), 'g\n')
    writeFileSync(join(seed, 'top.txt'), 't1\n')
    svn(['add', 'dir', 'old', 'top.txt'], seed)
    svn(['commit', '-m', 'seed'], seed)
  })

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('selected file under a newly added parent does not publish the unselected added sibling', async () => {
    const wc = freshWc('wc-added-parent')
    mkdirSync(join(wc, 'nueva'))
    writeFileSync(join(wc, 'nueva', 'seleccionado.txt'), 'a\n')
    writeFileSync(join(wc, 'nueva', 'no-seleccionado.txt'), 'b\n')
    svn(['add', 'nueva'], wc)

    const result = await commitSelectedPaths(wc, ['nueva/seleccionado.txt'], 'parcial', run)
    assert.equal(result.depth, 'empty')
    const tree = remoteTree()
    assert.ok(tree.includes('nueva/'))
    assert.ok(tree.includes('nueva/seleccionado.txt'))
    assert.ok(!tree.includes('nueva/no-seleccionado.txt'), 'el hermano desmarcado no debe publicarse')
    assert.equal(localStatus(wc)['nueva/no-seleccionado.txt'], 'A')
  })

  test('directory with only property changes commits the property, not modified children', async () => {
    const wc = freshWc('wc-props')
    svn(['propset', 'svn:ignore', '*.log', 'dir'], wc)
    writeFileSync(join(wc, 'dir', 'x.txt'), 'x2 sin seleccionar\n')

    await commitSelectedPaths(wc, ['dir'], 'solo propiedad', run)
    const status = localStatus(wc)
    assert.equal(status['dir/x.txt'], 'M', 'x.txt sigue modificado localmente')
    assert.equal(status.dir, undefined, 'la propiedad se publicó')
    assert.equal(svn(['cat', `${repoUrl}/dir/x.txt`]), 'x1\n')
  })

  test('unversioned file inside an unversioned directory is added with --parents and siblings stay unversioned', async () => {
    const wc = freshWc('wc-unversioned')
    mkdirSync(join(wc, 'nuevo'))
    writeFileSync(join(wc, 'nuevo', 'uno.txt'), '1\n')
    writeFileSync(join(wc, 'nuevo', 'otro.txt'), '2\n')

    await commitSelectedPaths(wc, ['nuevo/uno.txt'], 'nuevo con padre', run)
    const tree = remoteTree()
    assert.ok(tree.includes('nuevo/uno.txt'))
    assert.ok(!tree.includes('nuevo/otro.txt'))
    assert.equal(localStatus(wc)['nuevo/otro.txt'], '?')
  })

  test('a directory chosen together with all its children is committed completely', async () => {
    const wc = freshWc('wc-whole-dir')
    mkdirSync(join(wc, 'completo'))
    writeFileSync(join(wc, 'completo', 'a.txt'), 'a\n')
    writeFileSync(join(wc, 'completo', 'b.txt'), 'b\n')

    await commitSelectedPaths(wc, ['completo', 'completo/a.txt', 'completo/b.txt'], 'carpeta completa', run)
    const tree = remoteTree()
    assert.ok(tree.includes('completo/a.txt'))
    assert.ok(tree.includes('completo/b.txt'))
  })

  test('file names starting with "-" are treated as targets, not options', async () => {
    const wc = freshWc('wc-dash')
    writeFileSync(join(wc, '-raro.txt'), 'dash\n')
    await commitSelectedPaths(wc, ['-raro.txt'], 'dash', run)
    assert.ok(remoteTree().includes('-raro.txt'))
  })

  test('selected directory deletion commits recursively but refuses unrelated unselected changes', async () => {
    const wc = freshWc('wc-delete')
    svn(['delete', 'old'], wc)
    writeFileSync(join(wc, 'top.txt'), 't2 sin seleccionar\n')

    await commitSelectedPaths(wc, ['old', 'old/gone.txt'], 'borrar carpeta', run)
    const tree = remoteTree()
    assert.ok(!tree.includes('old/'))
    assert.equal(localStatus(wc)['top.txt'], 'M')
    assert.equal(svn(['cat', `${repoUrl}/top.txt`]), 't1\n')
  })

  test('rejects empty selections, escapes, absolute paths and empty messages', async () => {
    const wc = freshWc('wc-validation')
    await assert.rejects(commitSelectedPaths(wc, [], 'm', run), /al menos un archivo/)
    await assert.rejects(commitSelectedPaths(wc, ['  '], 'm', run), /al menos un archivo/)
    await assert.rejects(commitSelectedPaths(wc, ['../fuera.txt'], 'm', run), /fuera del repositorio/)
    await assert.rejects(commitSelectedPaths(wc, ['/etc/hosts'], 'm', run), /relativas/)
    await assert.rejects(commitSelectedPaths(wc, ['top.txt'], '   ', run), /mensaje/)
    await assert.rejects(commitSelectedPaths(wc, ['.svn/wc.db'], 'm', run), /\.svn/)
  })

  test('rejects targets that traverse a symlinked directory out of the working copy', async () => {
    const wc = freshWc('wc-symlink')
    const outside = join(root, 'outside-commit')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'marker.txt'), 'MARCADOR\n')
    symlinkSync(outside, join(wc, 'enlace'))
    assert.throws(() => normalizeSelection(wc, ['enlace/marker.txt']), /fuera del repositorio/)
  })

  test('rolls back the adds it performed when the commit itself fails', async () => {
    const wc = freshWc('wc-rollback')
    writeFileSync(join(wc, 'nuevo-fallo.txt'), 'f\n')
    const failingRun: SvnRunner = async (args, options) => {
      if (args[0] === 'commit') throw new Error('fallo simulado')
      return run(args, options)
    }
    await assert.rejects(commitSelectedPaths(wc, ['nuevo-fallo.txt'], 'm', failingRun), /fallo simulado/)
    assert.equal(localStatus(wc)['nuevo-fallo.txt'], '?')
  })

  test('revert only touches the selected file inside a directory', async () => {
    const wc = freshWc('wc-revert')
    writeFileSync(join(wc, 'dir', 'x.txt'), 'x-local\n')
    writeFileSync(join(wc, 'dir', 'y.txt'), 'y-local\n')
    await revertSelectedPaths(wc, ['dir/x.txt'], run)
    const status = localStatus(wc)
    assert.equal(status['dir/x.txt'], undefined)
    assert.equal(status['dir/y.txt'], 'M')
  })

  test('revert of a property-only directory does not discard modified children', async () => {
    const wc = freshWc('wc-revert-props')
    svn(['propset', 'svn:ignore', '*.tmp', 'dir'], wc)
    writeFileSync(join(wc, 'dir', 'y.txt'), 'y-keep\n')
    await revertSelectedPaths(wc, ['dir'], run)
    const status = localStatus(wc)
    assert.equal(status.dir, undefined)
    assert.equal(status['dir/y.txt'], 'M')
  })

  test('revert of an added directory un-adds it without deleting files (non-destructive recursion)', async () => {
    const wc = freshWc('wc-revert-added')
    mkdirSync(join(wc, 'agregada'))
    writeFileSync(join(wc, 'agregada', 'hijo.txt'), 'h\n')
    svn(['add', 'agregada'], wc)
    // Un-adding is non-destructive (files stay on disk) but must include the selected children.
    await revertSelectedPaths(wc, ['agregada', 'agregada/hijo.txt'], run)
    assert.equal(localStatus(wc).agregada, '?')
  })
})

describe('strict commit planning (pure)', () => {
  test('plan refuses recursive deletes when an unselected change under another target would be included', async () => {
    const status = await parseStatusXml(`<?xml version="1.0"?><status><target path=".">
      <entry path="old"><wc-status item="deleted" props="none"/></entry>
      <entry path="old/a.txt"><wc-status item="deleted" props="none"/></entry>
      <entry path="dir"><wc-status item="normal" props="modified"/></entry>
      <entry path="dir/x.txt"><wc-status item="modified" props="none"/></entry>
    </target></status>`)
    assert.throws(
      () => planStrictCommit(['old', 'dir'], status, new Map([['old', 'dir'], ['dir', 'dir']])),
      /no seleccionados \(dir\/x\.txt\)/
    )
  })

  test('plan adds required added ancestors as non-recursive targets', async () => {
    const status = await parseStatusXml(`<?xml version="1.0"?><status><target path=".">
      <entry path="n"><wc-status item="added" props="none"/></entry>
      <entry path="n/a.txt"><wc-status item="added" props="none"/></entry>
      <entry path="n/b.txt"><wc-status item="added" props="none"/></entry>
    </target></status>`)
    const plan = planStrictCommit(['n/a.txt'], status, new Map([['n/a.txt', 'file']]))
    assert.deepEqual(plan.targets, ['n', 'n/a.txt'])
    assert.equal(plan.depth, 'empty')
    assert.deepEqual(plan.effective.sort(), ['n', 'n/a.txt'])
  })
})
