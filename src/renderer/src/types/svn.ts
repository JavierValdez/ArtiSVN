export type MigrationAction = 'migrate-now' | 'remind-later' | 'start-without-migration'
export type MigrationStatus = 'pending' | 'in-progress' | 'completed' | 'blocked' | 'failed' | 'skipped'
export type MigrationItemStatus = 'pending' | 'copying' | 'completed' | 'not-found' | 'conflict' | 'failed'

export interface MigrationInspection {
  needed: boolean
  legacyConfigFound: boolean
  legacyReposFound: boolean
  canonicalConfigFound: boolean
  canonicalReposFound: boolean
  journalStatus: MigrationStatus | null
  journalValid: boolean
}

export interface MigrationConflict {
  area: 'journal' | 'config' | 'working-copy'
  code: string
  item?: string
}

export interface MigrationResult {
  action: MigrationAction
  status: MigrationStatus
  configStatus: MigrationItemStatus
  workingCopies: Record<string, MigrationItemStatus>
  conflicts: MigrationConflict[]
  errorCode?: string
}

export interface Credentials {
  username: string
  /**
   * Deprecated: kept only for backwards-compatible renderer state shape.
   * The real SVN password must never be returned from the main process to the renderer.
   */
  password?: string
  serverUrl: string
  hasPassword?: boolean
}

export interface RemoteServer {
  id: string
  name: string
  url: string
  createdAt: string
  active?: boolean
}

export type LocalRepoMetadataState = 'pending' | 'ready' | 'error'

export interface LocalRepo {
  id?: string
  name: string
  path: string
  /** Empty while metadata is pending. */
  url: string
  /** null = unknown (pending/error), never a fake 0. */
  revision: number | null
  lastUpdated: string | null
  changesCount: number | null
  author?: string
  metadataState?: LocalRepoMetadataState
  metadataError?: string
}

export type EditorId = 'vscode' | 'vscode-insiders'

export interface EditorOption {
  id: EditorId
  label: string
}

export interface FileChange {
  path: string
  status: 'M' | 'A' | 'D' | '?' | 'C' | '!' | 'R' | 'I'
  checked: boolean
  displayPath: string
  kind: 'file' | 'dir'
  rawStatus?: string
  wcLocked?: boolean
}

export interface BlameLine {
  lineNum: number
  revision: number
  author: string
  date: string
  content: string
}

export interface ConflictContent {
  mine: string
  theirs: string
  base: string
}

export type ConflictAccept = 'mine-full' | 'theirs-full' | 'working'

export interface LogEntry {
  revision: number
  author: string
  date: string
  message: string
  paths: LogPath[]
}

export interface LogPath {
  path: string
  action: 'A' | 'M' | 'D' | 'R'
}

export interface RemoteSearchResult {
  path: string
  name: string
  kind: 'dir' | 'file' | 'revision'
  matchType: 'name' | 'content' | 'comment'
  entryUrl: string
  revision?: number
  revisionMessage?: string
}

export interface RemoteEntry {
  name: string
  url: string
  kind: 'dir' | 'file'
  revision: number
  author: string
  date: string
  children?: RemoteEntry[]
  expanded?: boolean
  loading?: boolean
  isCheckedOut: boolean
  localPath?: string
}

export interface SvnInfo {
  url: string
  revision: number
  author: string
  date: string
  rootUrl: string
}

export interface CheckoutProgress {
  message: string
  done: boolean
  error?: string
}

export type ActiveTab = 'changes' | 'history' | 'explorer'

export interface AgentSession {
  id: string
  clientId: string
  clientName: string
  clientVersion?: string
  connectedAt: string
}

export interface AgentActivityEntry {
  id: string
  at: string
  kind: 'connect' | 'disconnect' | 'tool' | 'resource'
  clientId: string
  clientName: string
  action: string
  target?: string
  ok: boolean
  durationMs?: number
  error?: string
}

export interface AgentIntegrationState {
  enabled: boolean
  brokerRunning: boolean
  sessions: AgentSession[]
  activity: AgentActivityEntry[]
}

export interface AgentClientConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

/** Full file content exactly at a revision (`svn:revisionFileContent` / `svn:remoteRevisionFileContent`). */
export type RevisionSnapshot =
  | { kind: 'text'; path: string; revision: number; text: string; bytes: number; truncated: boolean; encoding: 'utf-8' | 'latin1' }
  | { kind: 'binary'; path: string; revision: number; bytes: number; truncated: boolean }
  | { kind: 'dir'; path: string; revision: number }
