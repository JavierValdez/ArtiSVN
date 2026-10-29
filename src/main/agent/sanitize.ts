import type { LocalRepoSummary } from '../services/read-ops'

export interface AgentLocalRepoSummary {
  id: string
  name: string
  url: string
  revision: number | null
  lastUpdated: string | null
  changesCount: number | null
  author?: string
  metadataState: 'pending' | 'ready' | 'error'
  metadataError?: string
}

export interface AgentRemoteEntry {
  name: string
  url: string
  kind: string
  revision: number
  author: string
  date: string
  isCheckedOut: boolean
}

export function sanitizeLocalRepo(repo: LocalRepoSummary): AgentLocalRepoSummary {
  const { path: _path, ...safeRepo } = repo
  return safeRepo
}

export function sanitizeRemoteEntry(entry: Record<string, unknown>): AgentRemoteEntry {
  return {
    name: String(entry.name || ''),
    url: String(entry.url || ''),
    kind: String(entry.kind || 'file'),
    revision: Number(entry.revision || 0),
    author: String(entry.author || ''),
    date: String(entry.date || ''),
    isCheckedOut: Boolean(entry.isCheckedOut)
  }
}
