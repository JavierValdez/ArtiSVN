import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSearchCache, runRemoteSearch } from '../src/main/services/remote-search-engine'
import { ListXmlScanner } from '../src/main/services/remote-search-xml'
import { SearchAbortedError, type SvnSearchDeps } from '../src/main/services/remote-search-svn'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('listing cache evicts by retained bytes, not only by entry count', () => {
  const cache = createSearchCache({ maxListingBytes: 600 })
  cache.setListing('a', [{ kind: 'file', path: 'a'.repeat(200) }])
  cache.setListing('b', [{ kind: 'file', path: 'b'.repeat(200) }])
  assert.equal(cache.getListing('a'), null)
  assert.ok(cache.getListing('b'))
  cache.setListing('huge', [{ kind: 'file', path: 'x'.repeat(2000) }])
  assert.equal(cache.getListing('huge'), null)
  assert.ok(cache.getListing('b'), 'an oversized snapshot must not evict useful smaller snapshots')
})

test('log cache also bounds retained message bytes', () => {
  const cache = createSearchCache({ maxLogBytes: 500 })
  cache.setLog('a', [{ revision: 1, message: 'a'.repeat(180) }])
  cache.setLog('b', [{ revision: 2, message: 'b'.repeat(180) }])
  assert.equal(cache.getLog('a'), null)
  assert.ok(cache.getLog('b'))
  cache.setLog('huge', [{ revision: 3, message: 'x'.repeat(2000) }])
  assert.equal(cache.getLog('huge'), null)
})

test('an unfinished XML document cannot be accepted as a complete listing', () => {
  const scanner = new ListXmlScanner()
  scanner.push('<lists><list path="https://fixture"><entry kind="file"><name>a.txt</name></entry>')
  assert.throws(() => scanner.end(), /XML|incomplet/i)
})

function deps(): SvnSearchDeps {
  return {
    identity: () => 'fixture', resolveHeadRevision: async () => 1,
    readLogMessages: async () => [],
    streamList: async (_url, options) => {
      for (let i = 0; i < 16; i++) if (options.onEntry({ kind: 'file', path: `file-${i}.txt` }) === false) return { status: 'stopped', bytes: 100 }
      return { status: 'complete', bytes: 100 }
    },
    catContains: async () => { await delay(2); return { match: false, bytesRead: 10, complete: true } }
  }
}

test('temporary byte reservations do not mark a fully searched tree as incomplete', async () => {
  const result = await runRemoteSearch({ url: 'https://fixture.invalid/svn', query: 'needle', deepSearch: true, limits: { maxTotalBytes: 500, maxFileBytes: 1000 } }, deps(), createSearchCache())
  assert.equal(result.searched, 16)
  assert.equal(result.contentBytes, 160)
  assert.equal(result.truncated, false)
  assert.equal(result.stopReason, undefined)
})

test('a failed listing aborts a concurrent log immediately instead of waiting for its deadline', async () => {
  const controller = new AbortController()
  let logAborted = false
  const d = deps()
  d.streamList = async () => { throw new Error('list denied') }
  d.readLogMessages = async (_url, _revision, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { logAborted = true; reject(new SearchAbortedError()) }, { once: true })
  })
  const task = runRemoteSearch({ url: 'https://fixture.invalid/svn', query: 'q', deepSearch: false, signal: controller.signal, limits: { maxDurationMs: 2000 } }, d, createSearchCache())
  const observed = task.then(() => 'resolved', () => 'rejected')
  try {
    assert.equal(await Promise.race([observed, delay(200).then(() => 'pending')]), 'rejected')
    assert.equal(logAborted, true)
  } finally { controller.abort(); await observed }
})
