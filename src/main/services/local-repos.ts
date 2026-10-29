import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildRepoId } from './read-contract'
import { BASE_REPO_PATH } from './local-paths'

/**
 * `pending`: discovered from disk, SVN metadata not read yet.
 * `ready`: metadata read from `svn info`/`svn status`.
 * `error`: metadata could not be read (broken/locked working copy).
 */
export type LocalRepoMetadataState = 'pending' | 'ready' | 'error'

export interface LocalRepoSummary {
  id: string
  name: string
  path: string
  /** Empty string while unknown. */
  url: string
  /** null while unknown — never a fake 0. */
  revision: number | null
  /** Last changed date of the working copy (svn info commit date). null while unknown. */
  lastUpdated: string | null
  /** Local changes count. null while unknown. */
  changesCount: number | null
  author?: string
  metadataState: LocalRepoMetadataState
  metadataError?: string
}

/**
 * Discovers working-copy roots from directory metadata only.
 *
 * Do not run `svn info` or `svn status` here: callers need this list during
 * application startup, and scanning large/iCloud-backed working copies would
 * block the renderer from showing any local repositories. Metadata is filled
 * in asynchronously by `local-repo-metadata.ts`.
 */
export function discoverLocalRepos(basePath = BASE_REPO_PATH): LocalRepoSummary[] {
  if (!existsSync(basePath)) return []

  const results: LocalRepoSummary[] = []

  for (const entry of readdirSync(basePath, { withFileTypes: true })) {
    try {
      if (!entry.isDirectory()) continue
      const fullPath = join(basePath, entry.name)
      if (!existsSync(join(fullPath, '.svn'))) continue

      results.push({
        id: buildRepoId(fullPath),
        name: entry.name,
        path: fullPath,
        url: '',
        revision: null,
        lastUpdated: null,
        changesCount: null,
        metadataState: 'pending'
      })
    } catch {
      // Ignore individual entries that disappear or become unavailable while
      // an iCloud/File Provider directory is being enumerated.
    }
  }

  return results.sort((left, right) => left.name.localeCompare(right.name))
}
