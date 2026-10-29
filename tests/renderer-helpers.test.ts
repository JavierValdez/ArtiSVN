import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getRemoteLogScopePath,
  isAuthError,
  isPathWithinRemoteLogScope,
  normalizeError,
  sortEntries,
  suggestRemoteName
} from '../src/renderer/src/components/explorer/explorerUtils'
import { describeSearchStop, initialSearchState } from '../src/renderer/src/components/explorer/useRemoteSearch'
import { describeRepoMeta, mergeRepoUpdate, repoChangesBadge, repoRevisionLabel } from '../src/renderer/src/utils/repoMeta'

test('sidebar never shows a fake r0 / zero badge for unknown metadata', () => {
  const pending = { revision: null, lastUpdated: null, changesCount: null, metadataState: 'pending' as const }
  assert.equal(repoRevisionLabel(pending), 'r…')
  assert.equal(describeRepoMeta(pending), 'Leyendo metadatos…')
  assert.equal(repoChangesBadge(pending), null)

  const error = { ...pending, metadataState: 'error' as const, metadataError: 'E155036' }
  assert.equal(repoRevisionLabel(error), 'r?')
  assert.match(describeRepoMeta(error), /Sin metadatos/)

  const now = new Date('2026-10-27T12:00:00Z')
  const ready = { revision: 485662, lastUpdated: '2026-10-27T10:00:00Z', changesCount: 3, metadataState: 'ready' as const }
  assert.equal(describeRepoMeta(ready, now), 'r485662 · hace 2h')
  assert.equal(repoChangesBadge(ready), 3)
  assert.equal(repoChangesBadge({ changesCount: 0 }), null)
})

test('pushed repo updates merge by path without adding unknown entries', () => {
  const repos = [
    { path: '/a', name: 'a', revision: null as number | null },
    { path: '/b', name: 'b', revision: null as number | null }
  ]
  const merged = mergeRepoUpdate(repos, { path: '/b', name: 'b', revision: 7 })
  assert.equal(merged[1].revision, 7)
  assert.equal(merged[0], repos[0])
  assert.equal(mergeRepoUpdate(repos, { path: '/zzz', name: 'z', revision: 1 }), repos)
})

test('explorer helpers keep their previous behavior', () => {
  assert.equal(normalizeError(new Error("Error invoking remote method 'svn:list': Error: E170013 boom")), 'E170013 boom')
  assert.equal(isAuthError(new Error('svn: E170001: Authorization failed')), true)
  assert.equal(suggestRemoteName('https://linrepo00.sat-interno.gob.gt/svn/proyectos/aduanas'), 'linrepo00.sat-interno.gob.gt/proyectos/aduanas')
  assert.equal(getRemoteLogScopePath('https://h/svn/repo', 'https://h/svn/repo/trunk/'), '/trunk')
  assert.equal(isPathWithinRemoteLogScope('/trunk/a.txt', '/trunk'), true)
  assert.equal(isPathWithinRemoteLogScope('/trunkx/a.txt', '/trunk'), false)

  const entries = [
    { name: 'b.txt', kind: 'file', revision: 5, date: '2026-01-02', url: 'u', author: '', isCheckedOut: false },
    { name: 'dir', kind: 'dir', revision: 1, date: '2026-01-01', url: 'u', author: '', isCheckedOut: false },
    { name: 'a.txt', kind: 'file', revision: 9, date: '2026-01-03', url: 'u', author: '', isCheckedOut: false }
  ] as any
  assert.deepEqual(sortEntries(entries, 'revision', 'desc').map((e: any) => e.name), ['dir', 'a.txt', 'b.txt'])
  assert.deepEqual(sortEntries(entries, 'name', 'asc').map((e: any) => e.name), ['dir', 'a.txt', 'b.txt'])
})

test('search stop reasons are explained to the user', () => {
  assert.equal(describeSearchStop(null), null)
  assert.match(describeSearchStop('cancelled') || '', /detenida/)
  assert.match(describeSearchStop('time') || '', /tiempo/)
  assert.equal(initialSearchState().stopReason, null)
})
