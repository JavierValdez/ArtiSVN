import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { ListXmlScanner } from '../src/main/services/remote-search-xml'
import { createSearchCache, runRemoteSearch, type SearchParams } from '../src/main/services/remote-search-engine'
import { createSvnSearchDeps, type SvnSpawner } from '../src/main/services/remote-search-svn'

// ── Streaming XML scanner ────────────────────────────────────────────────

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<lists>
<list
   path="file:///r/trunk">
<entry
   kind="dir">
<name>Carpeta &amp; más</name>
<commit
   revision="2">
<author>a&lt;b</author>
<date>2026-10-28T00:00:00.000000Z</date>
</commit>
</entry>
<entry
   kind="file">
<name>Carpeta &amp; más/a@b 100% &#233;&#x00F1;.txt</name>
<size>12</size>
<commit
   revision="2">
<author>x</author>
<date>2026-10-28T00:00:00.000000Z</date>
</commit>
</entry>
</list>
</lists>
`

test('list XML scanner yields the same entries for any chunk split and decodes entities', () => {
  const expected = [
    { kind: 'dir', path: 'Carpeta & más' },
    { kind: 'file', path: 'Carpeta & más/a@b 100% éñ.txt' }
  ]
  for (let size = 1; size <= LIST_XML.length; size += size < 16 ? 1 : 37) {
    const scanner = new ListXmlScanner()
    const got: Array<{ kind: string; path: string }> = []
    for (let i = 0; i < LIST_XML.length; i += size) got.push(...scanner.push(LIST_XML.slice(i, i + size)))
    scanner.end()
    assert.deepEqual(got, expected, `chunk size ${size}`)
  }
})

test('list XML scanner refuses unbounded garbage instead of buffering it forever', () => {
  const scanner = new ListXmlScanner({ maxPendingChars: 1000 })
  assert.throws(() => scanner.push(`<entry kind="file"><name>${'x'.repeat(5000)}`), /XML/)
})

// ── Real svn (svnadmin + file://) ────────────────────────────────────────

const hasSvn = spawnSync('svn', ['--version', '--quiet']).status === 0 && spawnSync('svnadmin', ['--version', '--quiet']).status === 0

function svn(args: string[], cwd?: string): string {
  const r = spawnSync('svn', ['--non-interactive', ...args], { cwd, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout
}

interface Harness {
  spawner: SvnSpawner
  calls: string[][]
  children: ChildProcessWithoutNullStreams[]
}

/** Real svn spawner that records commands; `override` can replace a command (slow/failing children). */
function harness(override?: (args: string[]) => [string, string[]] | null): Harness {
  const calls: string[][] = []
  const children: ChildProcessWithoutNullStreams[] = []
  const spawner: SvnSpawner = (args) => {
    calls.push(args)
    const replaced = override?.(args)
    const child = replaced ? spawn(replaced[0], replaced[1]) : spawn('svn', ['--non-interactive', ...args])
    children.push(child)
    return child
  }
  return { spawner, calls, children }
}

const SLOW_CHILD: [string, string[]] = [process.execPath, ['-e', 'setTimeout(() => {}, 20000)']]
const allExited = (h: Harness) => h.children.every((c) => c.exitCode !== null || c.signalCode !== null)
const count = (h: Harness, sub: string) => h.calls.filter((a) => a[0] === sub).length

describe('remote search engine against a real repository', { skip: !hasSvn && 'svn no disponible' }, () => {
  let root = ''
  let trunk = ''
  let wc = ''
  let rev2 = 0

  const params = (extra: Partial<SearchParams> = {}): SearchParams => ({
    url: trunk,
    query: 'needle',
    deepSearch: false,
    maxResults: 200,
    ...extra
  })

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'search-kiro-engine-')))
    spawnSync('svnadmin', ['create', join(root, 'repo')])
    const url = pathToFileURL(join(root, 'repo')).href
    trunk = `${url}/trunk`
    wc = join(root, 'wc')
    svn(['mkdir', '-m', 'trunk', trunk])
    svn(['checkout', trunk, wc])
    mkdirSync(join(wc, 'Needle Dir', 'sub'), { recursive: true })
    mkdirSync(join(wc, 'código'), { recursive: true })
    writeFileSync(join(wc, 'Needle Dir', 'sub', 'otro.txt'), 'nada\n')
    writeFileSync(join(wc, 'código', 'Canción NEEDLE.md'), 'x\n')
    writeFileSync(join(wc, 'código', 'a@b needle.txt'), 'x\n')
    writeFileSync(join(wc, 'código', '100% needle.txt'), 'x\n')
    writeFileSync(join(wc, 'código', 'dentro.java'), `${'linea\n'.repeat(400)}class X { // NeEdLe aqui\n}\n`)
    writeFileSync(join(wc, 'código', 'imagen.png'), 'needle in a binary extension')
    for (let i = 0; i < 12; i++) writeFileSync(join(wc, 'código', `relleno-${i}.txt`), 'r'.repeat(1000))
    svn(['add', '--force', '.'], wc)
    svn(['commit', '-m', 'inicial'], wc)
    svn(['update'], wc)
    svn(['propset', 'p', 'v', '.'], wc)
    svn(['commit', '-m', 'corrige needle en log'], wc)
    svn(['update'], wc)
    rev2 = Number(svn(['info', '--show-item', 'revision', '--no-newline', wc]))
    // r3: the "@" file disappears at HEAD.
    svn(['delete', 'código/a@b needle.txt@'], wc)
    svn(['commit', '-m', 'borra'], wc)
  })

  after(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  const names = (r: { results: Array<{ path: string; matchType: string }> }, type: string) =>
    r.results.filter((x) => x.matchType === type).map((x) => x.path).sort()

  test('name / comment / content semantics with spaces, @, %, accents and uppercase', async () => {
    const h = harness()
    const r = await runRemoteSearch(params({ deepSearch: true }), createSvnSearchDeps(h.spawner, () => 'id-a'), createSearchCache())
    assert.deepEqual(names(r, 'name'), ['Needle Dir', 'código/100% needle.txt', 'código/Canción NEEDLE.md'])
    assert.deepEqual(names(r, 'comment').length, 1)
    assert.deepEqual(names(r, 'content'), ['código/dentro.java'], 'binary extensions are skipped, name hits not re-scanned')
    assert.equal(r.truncated, false)
    assert.equal(r.incomplete, false)
    assert.equal(count(h, 'list'), 1, 'one recursive listing instead of one per folder')
    assert.ok(h.calls.find((a) => a[0] === 'list')!.includes('infinity'))
    assert.ok(allExited(h))
  })

  test('explicit historical revision includes paths deleted at HEAD', async () => {
    const h = harness()
    const old = await runRemoteSearch(params({ revision: rev2 }), createSvnSearchDeps(h.spawner, () => 'id-a'), createSearchCache())
    assert.ok(names(old, 'name').includes('código/a@b needle.txt'))
    assert.equal(old.revision, rev2)
    const head = await runRemoteSearch(params(), createSvnSearchDeps(harness().spawner, () => 'id-a'), createSearchCache())
    assert.ok(!names(head, 'name').includes('código/a@b needle.txt'))
    assert.ok((head.revision ?? 0) > rev2)
  })

  test('cache reuses a complete snapshot for the same identity and revision only', async () => {
    const cache = createSearchCache()
    const h = harness()
    const deps = (id: string) => createSvnSearchDeps(h.spawner, () => id)
    const first = await runRemoteSearch(params(), deps('user-a'), cache)
    const second = await runRemoteSearch(params(), deps('user-a'), cache)
    assert.equal(count(h, 'list'), 1)
    assert.equal(count(h, 'log'), 1)
    assert.equal(second.cached, true)
    assert.deepEqual(second.results, first.results)
    // Another identity on the same origin must not see user-a's snapshot.
    await runRemoteSearch(params(), deps('user-b'), cache)
    assert.equal(count(h, 'list'), 2)
    // A new commit moves HEAD: the cached snapshot is no longer used.
    writeFileSync(join(wc, 'nuevo needle.txt'), 'n')
    svn(['add', 'nuevo needle.txt'], wc)
    svn(['commit', '-m', 'nuevo'], wc)
    const third = await runRemoteSearch(params(), deps('user-a'), cache)
    assert.equal(count(h, 'list'), 3)
    assert.ok(names(third, 'name').includes('nuevo needle.txt'))
  })

  test('partial listings (entry cap) are reported and never cached', async () => {
    const cache = createSearchCache()
    const h = harness()
    const deps = createSvnSearchDeps(h.spawner, () => 'id-a')
    const partial = await runRemoteSearch(params({ limits: { maxEntries: 3 } }), deps, cache)
    assert.equal(partial.stopReason, 'entries')
    assert.equal(partial.truncated, true)
    await runRemoteSearch(params(), deps, cache)
    assert.equal(count(h, 'list'), 2, 'the partial tree was not cached')
    assert.ok(allExited(h))
  })

  test('failed content reads make the result incomplete instead of "no results"', async () => {
    const h = harness((args) => args[0] === 'cat' && args.some((a) => a.includes('relleno-3'))
      ? ['svn', ['--non-interactive', 'cat', `${trunk}/no-existe@1`]]
      : null)
    const r = await runRemoteSearch(params({ deepSearch: true }), createSvnSearchDeps(h.spawner, () => 'id-a'), createSearchCache())
    assert.equal(r.errorCounts?.content, 1)
    assert.equal(r.incomplete, true)
    assert.equal(r.truncated, true)
  })

  test('a bad base URL is an error, not an empty successful search', async () => {
    await assert.rejects(runRemoteSearch(params({ url: `${trunk}/no-existe` }), createSvnSearchDeps(harness().spawner, () => 'id-a'), createSearchCache()))
  })

  test('maxResults stops the search and kills in-flight children before returning', async () => {
    const h = harness()
    const r = await runRemoteSearch(params({ deepSearch: true, maxResults: 1 }), createSvnSearchDeps(h.spawner, () => 'id-a'), createSearchCache())
    assert.equal(r.results.length, 1)
    assert.equal(r.stopReason, 'results')
    assert.equal(r.truncated, true)
    assert.ok(allExited(h))
  })

  test('total content byte budget holds under concurrency', async () => {
    const h = harness()
    const r = await runRemoteSearch(
      params({ query: 'zzz-no-existe', deepSearch: true, limits: { maxTotalBytes: 3000, maxFileBytes: 1000 } }),
      createSvnSearchDeps(h.spawner, () => 'id-a'),
      createSearchCache()
    )
    assert.ok((r.contentBytes ?? 0) <= 3000, `read ${r.contentBytes}`)
    assert.equal(r.stopReason, 'bytes')
    assert.equal(r.truncated, true)
  })

  test('deadline aborts a slow listing child and returns promptly with partial results', async () => {
    const h = harness((args) => (args[0] === 'list' ? SLOW_CHILD : null))
    const progress: unknown[] = []
    const started = Date.now()
    const r = await runRemoteSearch(
      params({ limits: { maxDurationMs: 600 }, heartbeatMs: 100, onProgress: (p) => progress.push(p) }),
      createSvnSearchDeps(h.spawner, () => 'id-a'),
      createSearchCache()
    )
    const elapsed = Date.now() - started
    assert.equal(r.stopReason, 'time')
    assert.equal(r.truncated, true)
    assert.ok(elapsed < 600 + 2500, `elapsed ${elapsed}`)
    assert.ok(progress.length >= 3, `heartbeat while waiting: ${progress.length}`)
    assert.ok(allExited(h), 'no child left alive after returning')
  })

  test('external cancellation aborts the in-flight info call', async () => {
    const h = harness((args) => (args[0] === 'info' ? SLOW_CHILD : null))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const r = await runRemoteSearch(params({ signal: controller.signal }), createSvnSearchDeps(h.spawner, () => 'id-a'), createSearchCache())
    assert.equal(r.stopReason, 'cancelled')
    assert.ok(allExited(h))
  })

  test('an already aborted signal spawns nothing', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    const deps = createSvnSearchDeps(h.spawner, () => 'id-a')
    const cat = await deps.catContains(`${trunk}/código/dentro.java@1`, 'needle', { signal: controller.signal, maxBytes: 1000 })
    assert.equal(cat.match, false)
    const r = await runRemoteSearch(params({ signal: controller.signal }), deps, createSearchCache())
    assert.equal(r.stopReason, 'cancelled')
    assert.equal(h.calls.length, 0)
  })
})
