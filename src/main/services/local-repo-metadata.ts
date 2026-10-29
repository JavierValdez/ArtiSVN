import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalRepoSummary } from './local-repos'

/**
 * Asynchronous, cached enrichment of discovered working copies.
 *
 * - `svn info` metadata is cached per repository and invalidated when the
 *   working-copy database (`.svn/wc.db`) changes.
 * - Local change counts expire after `statusTtlMs`.
 * - All SVN calls are local/offline, bounded by timeouts and a concurrency cap,
 *   and de-duplicated while in flight.
 */

export interface RepoInfoMetadata {
  url: string
  revision: number
  lastUpdated: string | null
  author: string
}

export interface RepoMetadataRunner {
  readInfo(repoPath: string): Promise<RepoInfoMetadata>
  countChanges(repoPath: string): Promise<number>
}

interface CacheEntry {
  info?: RepoInfoMetadata
  infoFingerprint?: string
  changesCount?: number
  changesAt?: number
  error?: string
  errorAt?: number
}

export interface RepoMetadataServiceOptions {
  runner: RepoMetadataRunner
  concurrency?: number
  statusTtlMs?: number
  errorRetryMs?: number
  now?: () => number
  fingerprint?: (repoPath: string) => string
}

export interface EnrichOptions {
  /** Also compute local change count (slower: `svn status`). Default true. */
  includeStatus?: boolean
}

export function defaultWcFingerprint(repoPath: string): string {
  try {
    const stat = statSync(join(repoPath, '.svn', 'wc.db'))
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

export function createRepoMetadataService(options: RepoMetadataServiceOptions) {
  const runner = options.runner
  const concurrency = Math.max(1, options.concurrency ?? 3)
  const statusTtlMs = options.statusTtlMs ?? 30_000
  const errorRetryMs = options.errorRetryMs ?? 60_000
  const now = options.now ?? (() => Date.now())
  const fingerprint = options.fingerprint ?? defaultWcFingerprint

  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<LocalRepoSummary>>()
  let active = 0
  const waiters: Array<() => void> = []

  async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolveSlot) => waiters.push(resolveSlot))
    }
    active += 1
    try {
      return await task()
    } finally {
      active -= 1
      waiters.shift()?.()
    }
  }

  function merge(repo: LocalRepoSummary): LocalRepoSummary {
    const entry = cache.get(repo.id)
    if (!entry) return { ...repo }
    if (entry.info && entry.infoFingerprint === fingerprint(repo.path)) {
      return {
        ...repo,
        url: entry.info.url,
        revision: entry.info.revision,
        lastUpdated: entry.info.lastUpdated,
        author: entry.info.author,
        changesCount: entry.changesCount ?? null,
        metadataState: 'ready',
        metadataError: undefined
      }
    }
    if (entry.error) {
      return { ...repo, metadataState: 'error', metadataError: entry.error }
    }
    return { ...repo }
  }

  function isFresh(repo: LocalRepoSummary, includeStatus: boolean): boolean {
    const entry = cache.get(repo.id)
    if (!entry) return false
    if (entry.error && entry.errorAt !== undefined && now() - entry.errorAt < errorRetryMs && !entry.info) {
      return true
    }
    if (!entry.info || entry.infoFingerprint !== fingerprint(repo.path)) return false
    if (!includeStatus) return true
    return entry.changesAt !== undefined && now() - entry.changesAt < statusTtlMs
  }

  async function enrich(repo: LocalRepoSummary, enrichOptions: EnrichOptions = {}): Promise<LocalRepoSummary> {
    const includeStatus = enrichOptions.includeStatus !== false
    if (isFresh(repo, includeStatus)) return merge(repo)

    const key = `${repo.id}:${includeStatus ? 'full' : 'info'}`
    const pending = inflight.get(key)
    if (pending) return pending

    const promise = withSlot(async () => {
      const entry: CacheEntry = { ...(cache.get(repo.id) || {}) }
      const currentFingerprint = fingerprint(repo.path)
      try {
        if (!entry.info || entry.infoFingerprint !== currentFingerprint) {
          entry.info = await runner.readInfo(repo.path)
          entry.infoFingerprint = currentFingerprint
        }
        entry.error = undefined
        entry.errorAt = undefined
      } catch (error) {
        entry.info = undefined
        entry.infoFingerprint = undefined
        entry.error = error instanceof Error && error.message
          ? error.message.split('\n')[0].slice(0, 300)
          : 'No se pudieron leer los metadatos SVN'
        entry.errorAt = now()
        cache.set(repo.id, entry)
        return merge(repo)
      }

      if (includeStatus) {
        try {
          entry.changesCount = await runner.countChanges(repo.path)
          entry.changesAt = now()
        } catch {
          entry.changesCount = undefined
          entry.changesAt = undefined
        }
      }
      cache.set(repo.id, entry)
      return merge(repo)
    }).finally(() => inflight.delete(key))

    inflight.set(key, promise)
    return promise
  }

  async function enrichAll(
    repos: LocalRepoSummary[],
    enrichOptions: EnrichOptions & { onUpdate?: (repo: LocalRepoSummary) => void } = {}
  ): Promise<LocalRepoSummary[]> {
    return Promise.all(repos.map(async (repo) => {
      const before = merge(repo)
      const after = await enrich(repo, enrichOptions)
      if (enrichOptions.onUpdate && JSON.stringify(before) !== JSON.stringify(after)) {
        enrichOptions.onUpdate(after)
      }
      return after
    }))
  }

  function invalidate(repoId?: string): void {
    if (repoId) cache.delete(repoId)
    else cache.clear()
  }

  /** Forces the change count to be recomputed next time (after commit/revert/update). */
  function invalidateStatus(repoId: string): void {
    const entry = cache.get(repoId)
    if (entry) {
      entry.changesAt = undefined
    }
  }

  return { merge, enrich, enrichAll, invalidate, invalidateStatus }
}

export type RepoMetadataService = ReturnType<typeof createRepoMetadataService>
