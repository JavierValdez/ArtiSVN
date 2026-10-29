import type { RemoteEntry } from '../../types/svn'

/**
 * Pure helpers extracted from ExplorerView (no React/DOM), unit-tested in
 * tests/explorer-utils.test.ts.
 */

export type EntrySortMode = 'name' | 'revision' | 'date'

export function normalizeError(err: any): string {
  const raw = String(err?.message || err || 'Error desconocido')
  return raw.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '').trim()
}

export function isAuthError(err: any): boolean {
  const msg = normalizeError(err)
  return /Authentication|authorization|E170001|creden|autentic|contrasena|password/i.test(msg)
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleString('es-GT', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatDateShort(dateStr: string, now: Date = new Date()): string {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
    if (diffDays === 0) return 'hoy'
    if (diffDays === 1) return 'ayer'
    if (diffDays < 365) return d.toLocaleDateString('es-GT', { day: 'numeric', month: 'short' })
    return d.toLocaleDateString('es-GT', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return ''
  }
}

export function suggestRemoteName(url: string): string {
  const safeUrl = (url || '').trim()
  if (!safeUrl) return 'Servidor SVN'
  try {
    const parsed = new URL(safeUrl)
    const host = parsed.hostname || 'servidor'
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    const tail = pathParts.slice(-2).join('/')
    return tail ? `${host}/${tail}` : host
  } catch {
    const raw = safeUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    const parts = raw.split('/').filter(Boolean)
    return parts.slice(-2).join('/') || raw || 'Servidor SVN'
  }
}

export function normalizeRepoRelativePath(path: string): string {
  const trimmed = (path || '').trim()
  if (!trimmed || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`
}

export function getRemoteLogScopePath(repoRoot: string | null, targetUrl: string): string | null {
  const root = (repoRoot || '').trim().replace(/\/+$/, '')
  const target = (targetUrl || '').trim().replace(/\/+$/, '')
  if (!root || !target || !target.startsWith(root)) return null
  const relative = target.slice(root.length)
  return normalizeRepoRelativePath(relative)
}

export function isPathWithinRemoteLogScope(changedPath: string, scopePath: string | null): boolean {
  if (!scopePath || scopePath === '/') return true
  const normalizedChangedPath = normalizeRepoRelativePath(changedPath)
  return normalizedChangedPath === scopePath || normalizedChangedPath.startsWith(`${scopePath}/`)
}

function getEntryDateValue(entry: RemoteEntry): number {
  const value = Date.parse(entry.date || '')
  return Number.isFinite(value) ? value : 0
}

export function sortEntries(entries: RemoteEntry[], sortMode: EntrySortMode, dir: 'asc' | 'desc'): RemoteEntry[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1

    if (sortMode === 'name') {
      const nameDiff = left.name.localeCompare(right.name, 'es', { numeric: true, sensitivity: 'base' }) * sign
      if (nameDiff !== 0) return nameDiff
    } else if (sortMode === 'date') {
      const dateDiff = (getEntryDateValue(left) - getEntryDateValue(right)) * sign
      if (dateDiff !== 0) return dateDiff
    } else {
      const revisionDiff = (left.revision - right.revision) * sign
      if (revisionDiff !== 0) return revisionDiff
    }

    return left.name.localeCompare(right.name, 'es', { numeric: true, sensitivity: 'base' })
  })
}

/**
 * Folders to expand (base first) so that `entryUrl` becomes visible in a tree
 * rooted at `baseUrl`. null when the entry is outside the base.
 */
export function getSearchExpansionTrail(baseUrl: string, entryUrl: string): string[] | null {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const normalizedEntryUrl = entryUrl.replace(/\/+$/, '')
  const prefix = `${normalizedBaseUrl}/`
  if (!normalizedEntryUrl.startsWith(prefix)) return null

  const relativeParts = normalizedEntryUrl.slice(prefix.length).split('/').filter(Boolean)
  if (relativeParts.length === 0) return [normalizedBaseUrl]

  const foldersToExpand = [normalizedBaseUrl]
  let currentUrl = normalizedBaseUrl
  for (const part of relativeParts.slice(0, -1)) {
    currentUrl = `${currentUrl}/${part}`
    foldersToExpand.push(currentUrl)
  }
  return foldersToExpand
}
