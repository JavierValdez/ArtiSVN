import type { LocalRepo } from '../types/svn'

/** Lowercase and strip diacritics: «Aduanas Título» → «aduanas titulo». */
export function foldForSearch(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

/**
 * Local-only filter for the sidebar: every whitespace-separated term must
 * appear in the folder name. (Local paths are always `<Documents>/ArtiSVN/<name>`,
 * so matching the full path would make terms like "documents" match everything.)
 * An empty query returns the original array (same reference).
 */
export function filterLocalRepos<T extends Pick<LocalRepo, 'name'>>(repos: T[], query: string): T[] {
  const terms = foldForSearch(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return repos
  return repos.filter((repo) => {
    const name = foldForSearch(repo.name)
    return terms.every((term) => name.includes(term))
  })
}
