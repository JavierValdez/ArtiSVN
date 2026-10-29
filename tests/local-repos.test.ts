import assert from 'node:assert/strict'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { discoverLocalRepos } from '../src/main/services/local-repos'
import { createRepoMetadataService } from '../src/main/services/local-repo-metadata'

test('local repositories are discovered immediately from working-copy metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'artisvn-local-repos-'))

  try {
    mkdirSync(join(root, 'Repo B', '.svn'), { recursive: true })
    mkdirSync(join(root, 'Repo A', '.svn'), { recursive: true })
    mkdirSync(join(root, 'ordinary-folder'), { recursive: true })
    writeFileSync(join(root, 'README.txt'), 'not a repository')
    symlinkSync(join(root, 'Repo A'), join(root, 'repo-link'))

    const repos = discoverLocalRepos(root)

    assert.deepEqual(repos.map((repo) => repo.name), ['Repo A', 'Repo B'])
    assert.deepEqual(repos.map((repo) => repo.path), [join(root, 'Repo A'), join(root, 'Repo B')])
    // Unknown metadata is reported as unknown, never as a misleading zero.
    assert.ok(repos.every((repo) => repo.url === ''))
    assert.ok(repos.every((repo) => repo.revision === null))
    assert.ok(repos.every((repo) => repo.changesCount === null))
    assert.ok(repos.every((repo) => repo.lastUpdated === null))
    assert.ok(repos.every((repo) => repo.metadataState === 'pending'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local repository discovery returns an empty list for a missing base path', () => {
  assert.deepEqual(discoverLocalRepos(join(tmpdir(), 'artisvn-path-that-does-not-exist')), [])
})

function makeRepos() {
  const root = mkdtempSync(join(tmpdir(), 'artisvn-meta-'))
  for (const name of ['a', 'b', 'c', 'd']) mkdirSync(join(root, name, '.svn'), { recursive: true })
  return { root, repos: discoverLocalRepos(root) }
}

test('metadata enrichment fills real values, caches by wc fingerprint and limits concurrency', async () => {
  const { root, repos } = makeRepos()
  let active = 0
  let maxActive = 0
  let infoCalls = 0
  let fingerprint = 'v1'
  const service = createRepoMetadataService({
    concurrency: 2,
    fingerprint: () => fingerprint,
    runner: {
      async readInfo(repoPath) {
        infoCalls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
        active -= 1
        return { url: `https://svn.example/${repoPath.split(/[\\/]/).pop()}`, revision: 42, lastUpdated: '2026-10-27T00:00:00Z', author: 'ana' }
      },
      async countChanges() {
        return 3
      }
    }
  })
  try {
    const updates: string[] = []
    const enriched = await service.enrichAll(repos, { onUpdate: (repo) => updates.push(repo.name) })
    assert.ok(maxActive <= 2, `concurrency ${maxActive}`)
    assert.ok(enriched.every((repo) => repo.metadataState === 'ready' && repo.revision === 42 && repo.changesCount === 3))
    assert.equal(enriched[0].url, 'https://svn.example/a')
    assert.deepEqual(updates.sort(), ['a', 'b', 'c', 'd'])

    // Cached: merge() is synchronous and does not run svn again.
    assert.equal(service.merge(repos[0]).revision, 42)
    await service.enrichAll(repos, { includeStatus: false })
    assert.equal(infoCalls, 4)

    // wc.db changed (update/commit) → info re-read.
    fingerprint = 'v2'
    assert.equal(service.merge(repos[0]).metadataState, 'pending')
    await service.enrich(repos[0], { includeStatus: false })
    assert.equal(infoCalls, 5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('metadata errors are surfaced as error state instead of fake zeros', async () => {
  const { root, repos } = makeRepos()
  const service = createRepoMetadataService({
    fingerprint: () => 'x',
    runner: {
      async readInfo() { throw new Error('E155036: working copy locked\nmore') },
      async countChanges() { return 0 }
    }
  })
  try {
    const repo = await service.enrich(repos[0])
    assert.equal(repo.metadataState, 'error')
    assert.equal(repo.revision, null)
    assert.equal(repo.metadataError, 'E155036: working copy locked')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent enrich calls for the same repo are de-duplicated', async () => {
  const { root, repos } = makeRepos()
  let calls = 0
  const service = createRepoMetadataService({
    fingerprint: () => 'x',
    runner: {
      async readInfo() {
        calls += 1
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
        return { url: 'u', revision: 1, lastUpdated: null, author: '' }
      },
      async countChanges() { return 0 }
    }
  })
  try {
    await Promise.all([service.enrich(repos[0]), service.enrich(repos[0]), service.enrich(repos[0])])
    assert.equal(calls, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
