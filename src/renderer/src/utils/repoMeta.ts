import type { LocalRepo } from '../types/svn'

/** Relative time in Spanish; empty for unknown/invalid dates. */
export function timeAgo(dateStr: string | null | undefined, now: Date = new Date()): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000)
  if (diff < 60) return 'hace un momento'
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`
  return `hace ${Math.floor(diff / 86400)} días`
}

/** `r123`, or a placeholder while metadata is unknown (never a fake `r0`). */
export function repoRevisionLabel(repo: Pick<LocalRepo, 'revision' | 'metadataState'>): string {
  if (typeof repo.revision === 'number') return `r${repo.revision}`
  return repo.metadataState === 'error' ? 'r?' : 'r…'
}

/** Sidebar subtitle for a local working copy. */
export function describeRepoMeta(
  repo: Pick<LocalRepo, 'revision' | 'lastUpdated' | 'metadataState' | 'metadataError'>,
  now: Date = new Date()
): string {
  if (repo.metadataState === 'error') return 'Sin metadatos SVN (revisa la working copy)'
  if (typeof repo.revision !== 'number') return 'Leyendo metadatos…'
  const when = timeAgo(repo.lastUpdated, now)
  return when ? `${repoRevisionLabel(repo)} · ${when}` : repoRevisionLabel(repo)
}

/** Only real, known counts produce a badge. */
export function repoChangesBadge(repo: Pick<LocalRepo, 'changesCount'>): number | null {
  return typeof repo.changesCount === 'number' && repo.changesCount > 0 ? repo.changesCount : null
}

/** Merges a pushed `repos:updated` entry into the current list (by path). */
export function mergeRepoUpdate<T extends Pick<LocalRepo, 'path'>>(repos: T[], updated: T): T[] {
  let found = false
  const next = repos.map((repo) => {
    if (repo.path !== updated.path) return repo
    found = true
    return { ...repo, ...updated }
  })
  return found ? next : repos
}
