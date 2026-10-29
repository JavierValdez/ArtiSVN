import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { ensureRemotesSeeded, getCredentialsForOrigin, listCredentialOriginKeys, StoredRemote } from './store'
import { runSvn, spawnSvn, terminateProcess, SvnCancelledError } from './svn-runtime'
import { BASE_REPO_PATH } from './local-paths'
import { discoverLocalRepos, type LocalRepoSummary } from './local-repos'
import { createRepoMetadataService, type RepoInfoMetadata } from './local-repo-metadata'
import { readFileBounded, resolvePhysicalRepoTarget } from './path-guard'
import { credentialOriginKeyFromUrl } from './svn-policy'
import { buildRevisionUrl, readRevisionSnapshot, type RevisionSnapshot } from './revision-snapshot'
import {
  runRemoteSearch,
  type RemoteSearchResponse,
  type RemoteSearchResult,
  type SearchLimits,
  type SearchProgress
} from './remote-search-engine'
import { createSvnSearchDeps } from './remote-search-svn'

const _require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xml2js = _require('xml2js') as any
const parseStringPromise = xml2js.parseStringPromise

export { BASE_REPO_PATH } from './local-paths'
export {
  MAX_TEXT_RESULT_LENGTH,
  buildHistoricalRemoteTarget,
  buildRepoId,
  normalizeRemoteRevision,
  normalizeRelativePath,
  normalizeRepoUrl,
  resolveRepoRelativeTarget,
  truncateText,
  validateReadOnlyRemoteUrl
} from './read-contract'
export type { TextResult } from './read-contract'
import {
  buildHistoricalRemoteTarget,
  normalizeRelativePath,
  normalizeRemoteRevision,
  normalizeRepoUrl,
  type TextResult,
  truncateText,
  validateReadOnlyRemoteUrl
} from './read-contract'

export type LocalChangeStatus = 'M' | 'A' | 'D' | '?' | 'C' | '!' | 'R' | 'I'

export interface LocalStatusChange {
  path: string
  displayPath: string
  status: LocalChangeStatus
  checked: boolean
  kind: 'file' | 'dir'
  rawStatus: string
  wcLocked: boolean
}

export type { LocalRepoSummary } from './local-repos'

export type {
  RemoteSearchResponse,
  RemoteSearchResult,
  SearchLimits,
  SearchProgress,
  SearchStopReason
} from './remote-search-engine'
export { DEFAULT_SEARCH_LIMITS } from './remote-search-engine'

/** Max bytes read from a local file for text preview / MCP content. */
export const MAX_LOCAL_TEXT_BYTES = 2 * 1024 * 1024
/** Max bytes read from `svn cat` for text preview / MCP content. */
export const MAX_REMOTE_TEXT_BYTES = 2 * 1024 * 1024
/** Max diff output kept. */
export const MAX_DIFF_BYTES = 4 * 1024 * 1024
/** Max file size for local blame. */
export const MAX_BLAME_FILE_BYTES = 5 * 1024 * 1024

async function parseXml(xml: string): Promise<any> {
  return parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: false
  })
}

export function parseLogEntries(parsed: any): any[] {
  const entries = parsed.log?.logentry
  if (!entries) return []
  const arr = Array.isArray(entries) ? entries : [entries]
  return arr.map((entry: any) => {
    let paths: any[] = []
    if (entry.paths?.path) {
      paths = Array.isArray(entry.paths.path) ? entry.paths.path : [entry.paths.path]
    }
    return {
      revision: parseInt(entry.$?.revision || '0'),
      author: entry.author || '',
      date: entry.date || '',
      message: entry.msg || '',
      paths: paths.map((path: any) => ({
        path: typeof path === 'string' ? path : path._ || '',
        action: path.$?.action || 'M'
      }))
    }
  })
}

function normalizeStatusEntryPath(repoPath: string, entryPath: string): string {
  const rawPath = String(entryPath || '.').replace(/\\/g, '/')
  if (!rawPath || rawPath === '.') return '.'
  if (isAbsolute(rawPath)) {
    const rel = relative(resolve(repoPath), rawPath).replace(/\\/g, '/')
    return normalizeRelativePath(rel) || '.'
  }
  return normalizeRelativePath(rawPath) || '.'
}

function detectStatusEntryKind(repoPath: string, relPath: string): 'file' | 'dir' {
  try {
    const abs = relPath === '.' ? resolve(repoPath) : resolve(repoPath, relPath)
    return existsSync(abs) && statSync(abs).isDirectory() ? 'dir' : 'file'
  } catch {
    return 'file'
  }
}

function mapStatus(item: string, props = 'none'): LocalChangeStatus | null {
  const safeItem = String(item || 'normal')
  const safeProps = String(props || 'none')
  if (safeItem === 'normal') {
    if (safeProps === 'modified') return 'M'
    if (safeProps === 'conflicted') return 'C'
    return null
  }

  const map: Record<string, LocalChangeStatus> = {
    modified: 'M',
    merged: 'M',
    added: 'A',
    deleted: 'D',
    unversioned: '?',
    conflicted: 'C',
    missing: '!',
    obstructed: '!',
    replaced: 'R',
    incomplete: 'I'
  }

  if (safeItem === 'none' || safeItem === 'ignored' || safeItem === 'external') return null
  return map[safeItem] || '?'
}

export function buildStatusChangesFromParsed(parsed: any, repoPath: string): LocalStatusChange[] {
  const target = parsed.status?.target
  if (!target?.entry) return []

  const entries = Array.isArray(target.entry) ? target.entry : [target.entry]
  const baseChanges: LocalStatusChange[] = []
  for (const entry of entries) {
    const wcStatus = entry['wc-status']?.$ || {}
    const item = String(wcStatus.item || 'normal')
    const props = String(wcStatus.props || 'none')
    const status = mapStatus(item, props)
    if (!status) continue

    const path = normalizeStatusEntryPath(repoPath, entry.$?.path)
    baseChanges.push({
      path,
      displayPath: path,
      status,
      checked: status !== '?' && status !== 'I',
      kind: detectStatusEntryKind(repoPath, path),
      rawStatus: item,
      wcLocked: String(wcStatus['wc-locked'] || '') === 'true'
    })
  }

  const expandedFromUnversionedDirs: LocalStatusChange[] = []
  const walkUnversionedDir = (absDir: string, relDir: string) => {
    try {
      for (const child of readdirSync(absDir, { withFileTypes: true })) {
        if (child.name === '.svn') continue
        const childAbs = join(absDir, child.name)
        const childRel = join(relDir === '.' ? '' : relDir, child.name).replace(/\\/g, '/')
        if (child.isDirectory?.()) {
          expandedFromUnversionedDirs.push({
            path: childRel,
            displayPath: childRel,
            status: '?',
            checked: false,
            kind: 'dir',
            rawStatus: 'unversioned',
            wcLocked: false
          })
          walkUnversionedDir(childAbs, childRel)
        } else {
          expandedFromUnversionedDirs.push({
            path: childRel,
            displayPath: childRel,
            status: '?',
            checked: false,
            kind: 'file',
            rawStatus: 'unversioned',
            wcLocked: false
          })
        }
      }
    } catch {
      return
    }
  }

  for (const change of baseChanges) {
    if (change.status !== '?') continue
    const abs = change.path === '.' ? resolve(repoPath) : resolve(repoPath, change.path)
    try {
      if (statSync(abs).isDirectory()) walkUnversionedDir(abs, change.path)
    } catch {
      // ignore invalid paths
    }
  }

  const merged = new Map<string, LocalStatusChange>()
  for (const change of baseChanges) merged.set(change.path, change)
  for (const change of expandedFromUnversionedDirs) {
    if (!merged.has(change.path)) merged.set(change.path, change)
  }
  return Array.from(merged.values())
}

// ─── Local repositories: fast discovery + cached asynchronous metadata ─────

async function readRepoInfo(repoPath: string): Promise<RepoInfoMetadata> {
  // `svn info` on a working-copy path is offline.
  const { stdout } = await runSvn(['info', '--xml', repoPath], { skipAuth: true, timeoutMs: 15_000 })
  const parsed = await parseXml(stdout)
  const entry = parsed.info?.entry
  if (!entry) throw new Error('svn info no devolvió metadatos')
  const revision = Number.parseInt(String(entry?.$?.revision || ''), 10)
  return {
    url: String(entry?.url || ''),
    revision: Number.isFinite(revision) ? revision : 0,
    lastUpdated: entry?.commit?.date ? String(entry.commit.date) : null,
    author: String(entry?.commit?.author || '')
  }
}

async function countRepoChanges(repoPath: string): Promise<number> {
  // Local status only (no `-u`), so no network access is needed.
  const { stdout } = await runSvn(['status', '--xml', repoPath], { skipAuth: true, timeoutMs: 30_000 })
  return buildStatusChangesFromParsed(await parseXml(stdout), repoPath).length
}

export const repoMetadata = createRepoMetadataService({
  runner: { readInfo: readRepoInfo, countChanges: countRepoChanges },
  concurrency: 3
})

/** Fast list for startup: discovered repos merged with cached metadata (never blocks on SVN). */
export async function listLocalRepos(): Promise<LocalRepoSummary[]> {
  return discoverLocalRepos(BASE_REPO_PATH).map((repo) => repoMetadata.merge(repo))
}

/** Lazily enriched list (used by MCP and background refresh). */
export async function listLocalReposEnriched(options: {
  includeStatus?: boolean
  onUpdate?: (repo: LocalRepoSummary) => void
} = {}): Promise<LocalRepoSummary[]> {
  return repoMetadata.enrichAll(discoverLocalRepos(BASE_REPO_PATH), options)
}

export async function resolveLocalRepo(
  repoId: string,
  options: { includeStatus?: boolean } = {}
): Promise<LocalRepoSummary> {
  const repo = discoverLocalRepos(BASE_REPO_PATH).find((candidate) => candidate.id === repoId)
  if (!repo) throw new Error('Repositorio local no encontrado')
  return repoMetadata.enrich(repo, { includeStatus: options.includeStatus ?? false })
}

export async function getLocalRepoUrlIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  for (const repo of await listLocalReposEnriched({ includeStatus: false })) {
    const normalized = normalizeRepoUrl(repo.url)
    if (normalized) index.set(normalized, repo.path)
  }
  return index
}

export async function listRemote(url: string, revision?: number): Promise<any[]> {
  const target = buildHistoricalRemoteTarget(url, revision)
  const { stdout } = await runSvn(
    ['list', '--xml', ...target.revisionArgs, target.targetUrl],
    { timeoutMs: 30000 }
  )
  const parsed = await parseXml(stdout)
  const list = parsed.lists?.list
  if (!list) return []
  const entries = list.entry
  if (!entries) return []

  const arr = Array.isArray(entries) ? entries : [entries]
  const normalizedBaseUrl = normalizeRepoUrl(target.safeUrl)
  const localRepoUrlIndex = await getLocalRepoUrlIndex()
  const isDirectFileListing = arr.length === 1
    && String(arr[0]?.$?.kind || '') === 'file'
    && basename(normalizedBaseUrl) === String(arr[0]?.name?._?.trim() || arr[0]?.name || '').replace(/\/$/, '')

  return arr.map((entry: any) => {
    const name = String(entry.name?._?.trim() || entry.name || '').replace(/\/$/, '')
    const isDir = entry.$?.kind === 'dir'
    const entryUrl = isDirectFileListing ? normalizedBaseUrl : `${normalizedBaseUrl}/${name}`
    const localPath = localRepoUrlIndex.get(normalizeRepoUrl(entryUrl))
    return {
      name,
      url: entryUrl,
      kind: entry.$?.kind || 'file',
      revision: parseInt(entry.commit?.$?.revision || '0'),
      author: entry.commit?.author || '',
      date: entry.commit?.date || new Date().toISOString(),
      isCheckedOut: Boolean(localPath) && isDir,
      localPath: localPath && isDir ? localPath : undefined
    }
  })
}

// ─── Remote search (engine in remote-search-engine.ts) ─────────────────────

const SEARCH_IDENTITY_SALT = randomBytes(32)

/**
 * Opaque, per-process identity of the credentials bound to the URL's origin.
 * Partitions the in-memory search cache so a different user/password on the
 * same origin never reuses another account's tree. Never logged or returned.
 */
function searchCredentialIdentity(url: string): string {
  const originKey = credentialOriginKeyFromUrl(url) || 'no-origin'
  const creds = getCredentialsForOrigin(originKey)
  return createHash('sha256')
    .update(SEARCH_IDENTITY_SALT)
    .update(originKey)
    .update('\0')
    .update(creds?.username || '')
    .update('\0')
    .update(creds?.password || '')
    .digest('hex')
}

export async function searchRemote(
  url: string,
  query: string,
  deepSearch: boolean,
  options: {
    maxResults?: number
    onProgress?: (progress: SearchProgress) => void
    onResult?: (result: RemoteSearchResult) => void
    revision?: number
    signal?: AbortSignal
    limits?: Partial<SearchLimits>
  } = {}
): Promise<RemoteSearchResponse> {
  const target = buildHistoricalRemoteTarget(url, options.revision)
  // spawnSvn keeps the password on stdin, per-origin credentials and TLS policy.
  const deps = createSvnSearchDeps((args) => spawnSvn(args), searchCredentialIdentity)
  return runRemoteSearch({
    url: target.safeUrl,
    query,
    deepSearch,
    revision: target.revision,
    maxResults: options.maxResults,
    limits: options.limits,
    signal: options.signal,
    onProgress: options.onProgress,
    onResult: options.onResult
  }, deps)
}

export async function localStatus(repoPath: string): Promise<LocalStatusChange[]> {
  const { stdout } = await runSvn(['status', '--xml'], { cwd: repoPath, timeoutMs: 120_000 })
  return buildStatusChangesFromParsed(await parseXml(stdout), repoPath)
}

export async function localDiff(repoPath: string, filePath: string): Promise<TextResult> {
  const { relativePath } = resolvePhysicalRepoTarget(repoPath, filePath, { allowSymlinkLeaf: true })
  const target = relativePath || '.'
  try {
    const { stdout, truncated } = await runSvn(['diff', '--', target], {
      cwd: repoPath,
      timeoutMs: 120_000,
      maxStdoutBytes: MAX_DIFF_BYTES
    })
    const result = truncateText(stdout || '(sin cambios)')
    return truncated ? { ...result, truncated: true } : result
  } catch {
    try {
      const { stdout } = await runSvn(['status', '--xml', '--', target], { cwd: repoPath, timeoutMs: 30_000 })
      const parsed = await parseXml(stdout)
      const statusTarget = parsed.status?.target
      const entry = Array.isArray(statusTarget?.entry) ? statusTarget.entry[0] : statusTarget?.entry
      if (entry?.['wc-status']?.$?.item === 'unversioned') {
        return truncateText('(archivo sin versionar: SVN no genera diff hasta hacer add/commit)')
      }
    } catch {
      // ignore
    }
    return truncateText('(no se pudo obtener el diff)')
  }
}

/** Reads local text content with physical containment and a byte cap before reading. */
export function localFileContent(repoPath: string, filePath: string): TextResult {
  let physical
  try {
    physical = resolvePhysicalRepoTarget(repoPath, filePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/fuera del repositorio/i.test(message)) throw error
    return truncateText('(archivo no encontrado)')
  }
  if (!physical.exists) return truncateText('(archivo no encontrado)')
  try {
    if (!statSync(physical.targetReal).isFile()) return truncateText('(no es un archivo regular)')
    const read = readFileBounded(physical.targetReal, MAX_LOCAL_TEXT_BYTES)
    const text = read.buffer.toString('utf-8')
    const result = truncateText(text || '(archivo vacío)')
    if (!read.truncated) return result
    return {
      text: `${result.text}\n\n[... contenido truncado: ${read.size} bytes en disco ...]`,
      truncated: true,
      originalLength: read.size
    }
  } catch {
    return truncateText('(no se pudo leer el contenido del archivo)')
  }
}

export async function localLog(repoPath: string, limit = 50, fromRevision?: number): Promise<any[]> {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50))
  const safeFromRevision = Number(fromRevision)
  const args = ['log', '--xml', '--verbose', `--limit=${safeLimit}`]
  if (Number.isFinite(safeFromRevision) && safeFromRevision > 0) {
    args.push('-r', `${Math.floor(safeFromRevision)}:1`)
  } else {
    args.push('-r', 'HEAD:1')
  }
  const { stdout } = await runSvn(args, { cwd: repoPath, timeoutMs: 120_000 })
  return parseLogEntries(await parseXml(stdout))
}

export async function localBlame(repoPath: string, filePath: string): Promise<any[]> {
  const physical = resolvePhysicalRepoTarget(repoPath, filePath, { mustExist: true })
  if (!statSync(physical.targetReal).isFile()) throw new Error('Blame solo está disponible para archivos')
  const read = readFileBounded(physical.targetReal, MAX_BLAME_FILE_BYTES)
  if (read.truncated) throw new Error('El archivo es demasiado grande para blame')

  const { stdout } = await runSvn(['blame', '--xml', '--', physical.relativePath], {
    cwd: repoPath,
    timeoutMs: 60000,
    maxStdoutBytes: 64 * 1024 * 1024
  })
  const parsed = await parseXml(stdout)
  const entries = parsed.blame?.target?.entry
  const blameEntries = entries ? (Array.isArray(entries) ? entries : [entries]) : []
  const normalizedContent = read.buffer.toString('utf-8').replace(/\r\n/g, '\n')
  const lines = normalizedContent.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) lines.push('')

  return lines.map((content, index) => {
    const commit = blameEntries[index]?.commit
    return {
      lineNum: index + 1,
      revision: Number.parseInt(commit?.$?.revision || '0', 10) || 0,
      author: String(commit?.author || ''),
      date: String(commit?.date || ''),
      content
    }
  })
}

export { normalizeRepoScopedSvnPath } from './revision-snapshot'
export type { RevisionSnapshot } from './revision-snapshot'

async function diffAtRevision(rootUrl: string, svnPath: string, revision: number): Promise<TextResult> {
  const safeRevision = normalizeRemoteRevision(revision)
  if (!safeRevision) throw new Error('La revisión es requerida')
  // Pegged at the revision itself: works even if the file was renamed/deleted later,
  // and keeps names with spaces or "@" unambiguous.
  const pegUrl = buildRevisionUrl(rootUrl, svnPath, safeRevision)
  try {
    const { stdout, truncated } = await runSvn(['diff', `-c${safeRevision}`, '-x', '-U 9999', '--', pegUrl], {
      timeoutMs: 120_000,
      maxStdoutBytes: MAX_DIFF_BYTES
    })
    const result = truncateText(stdout || '(sin cambios en esta revisión)')
    return truncated ? { ...result, truncated: true } : result
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('was added') || message.includes('E195020')) {
      return truncateText(`(archivo añadido en r${safeRevision})`)
    }
    throw error
  }
}

async function workingCopyRootUrl(repoPath: string): Promise<string> {
  // Offline: read from the working copy metadata.
  const { stdout: infoXml } = await runSvn(['info', '--xml'], { cwd: repoPath, timeoutMs: 15_000 })
  const parsed = await parseXml(infoXml)
  const rootUrl = parsed?.info?.entry?.repository?.root || ''
  if (!rootUrl) throw new Error('No se pudo obtener la URL raíz del repositorio')
  return rootUrl
}

async function remoteRootUrl(baseUrl: string): Promise<string> {
  const { stdout: infoXml } = await runSvn(['info', '--xml', '--', validateReadOnlyRemoteUrl(baseUrl)], { timeoutMs: 30_000 })
  const parsed = await parseXml(infoXml)
  const rootUrl = parsed?.info?.entry?.repository?.root || ''
  if (!rootUrl) throw new Error('No se pudo obtener la URL raíz del repositorio')
  return rootUrl
}

export async function localRevisionFileDiff(
  repoPath: string,
  revision: number,
  svnPath: string
): Promise<TextResult> {
  return diffAtRevision(await workingCopyRootUrl(repoPath), svnPath, revision)
}

export async function svnInfo(path: string): Promise<any> {
  const { stdout } = await runSvn(['info', '--xml', path], { timeoutMs: 30_000 })
  const parsed = await parseXml(stdout)
  const entry = parsed.info?.entry
  return {
    url: entry?.url || '',
    revision: parseInt(entry?.$?.revision || '0'),
    author: entry?.commit?.author || '',
    date: entry?.commit?.date || '',
    rootUrl: entry?.repository?.root || ''
  }
}

export async function remoteLog(url: string, limit = 50, revision?: number): Promise<any[]> {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50))
  const target = buildHistoricalRemoteTarget(url, revision)
  const args = ['log', '--xml', '--verbose', `--limit=${safeLimit}`]
  if (target.revision) args.push('-r', `${target.revision}:1`)
  args.push(target.targetUrl)
  const { stdout } = await runSvn(args, { timeoutMs: 30000 })
  return parseLogEntries(await parseXml(stdout))
}

export async function remoteFileContent(url: string, revision?: number): Promise<TextResult> {
  const target = buildHistoricalRemoteTarget(url, revision)
  const { stdout, truncated } = await runSvn(['cat', ...target.revisionArgs, target.targetUrl], {
    timeoutMs: 120_000,
    maxStdoutBytes: MAX_REMOTE_TEXT_BYTES
  })
  const result = truncateText(stdout)
  if (!truncated) return result
  return { text: `${result.text}\n\n[... contenido truncado ...]`, truncated: true, originalLength: result.originalLength }
}

export async function remoteRepoRoot(url: string, revision?: number): Promise<string | null> {
  const target = buildHistoricalRemoteTarget(url, revision)
  const { stdout } = await runSvn(['info', '--xml', ...target.revisionArgs, target.targetUrl], { timeoutMs: 30_000 })
  const parsed = await parseXml(stdout)
  return (parsed?.info?.entry?.repository?.root as string) || null
}

export async function remoteInfo(url: string, revision?: number): Promise<any> {
  const target = buildHistoricalRemoteTarget(url, revision)
  const { stdout } = await runSvn(['info', '--xml', ...target.revisionArgs, target.targetUrl], { timeoutMs: 30_000 })
  const parsed = await parseXml(stdout)
  const entry = parsed.info?.entry
  return {
    url: entry?.url || '',
    revision: parseInt(entry?.$?.revision || '0'),
    author: entry?.commit?.author || '',
    date: entry?.commit?.date || '',
    rootUrl: entry?.repository?.root || ''
  }
}

export async function remoteRevisionDiff(baseUrl: string, svnPath: string, revision: number): Promise<TextResult> {
  return diffAtRevision(await remoteRootUrl(baseUrl), svnPath, revision)
}

// ─── Full file snapshot at a revision (read-only, byte-capped) ─────────────

const SNAPSHOT_TIMEOUT_MS = 120_000

/** `svn cat` into a Buffer (lossless for any encoding), stopping after `maxBytes`. */
function catBytes(pegUrl: string, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  return new Promise((resolvePromise, reject) => {
    let proc: ReturnType<typeof spawnSvn>
    try {
      proc = spawnSvn(['cat', '--', pegUrl])
    } catch (error) {
      reject(error as Error)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    let exited = false
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      terminateProcess(proc, () => exited)
    }, SNAPSHOT_TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      const room = maxBytes - size
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, Math.max(0, room)))
        size = maxBytes
        truncated = true
        terminateProcess(proc, () => exited)
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString()
    })
    proc.on('error', (error) => {
      exited = true
      clearTimeout(timer)
      reject(error)
    })
    // Resolve only after the child has exited (no writes after we return).
    proc.on('close', (code) => {
      exited = true
      clearTimeout(timer)
      if (truncated) resolvePromise({ buffer: Buffer.concat(chunks), truncated: true })
      else if (timedOut) reject(new Error(`Tiempo de espera agotado (${SNAPSHOT_TIMEOUT_MS / 1000}s) al leer el archivo`))
      else if (code === 0) resolvePromise({ buffer: Buffer.concat(chunks), truncated: false })
      else reject(new Error(stderr.trim() || `SVN exited with code ${code}`))
    })
  })
}

async function readNodeKind(pegUrl: string): Promise<'file' | 'dir'> {
  const { stdout } = await runSvn(['info', '--show-item', 'kind', '--no-newline', '--', pegUrl], { timeoutMs: 30_000 })
  return stdout.trim() === 'dir' ? 'dir' : 'file'
}

const snapshotDeps = { readKind: readNodeKind, readBytes: catBytes }

/** Exact content of `svnPath` at `revision` for a local working copy's repository. */
export async function localRevisionFileSnapshot(repoPath: string, revision: number, svnPath: string): Promise<RevisionSnapshot> {
  return readRevisionSnapshot(await workingCopyRootUrl(repoPath), svnPath, revision, snapshotDeps)
}

/** Exact content of `svnPath` at `revision`, resolving the repository root from `baseUrl`. */
export async function remoteRevisionFileSnapshot(baseUrl: string, svnPath: string, revision: number): Promise<RevisionSnapshot> {
  return readRevisionSnapshot(await remoteRootUrl(baseUrl), svnPath, revision, snapshotDeps)
}

/**
 * Origins an MCP client may target with a free `url`: those of configured
 * remotes and of saved credentials. Anything else is rejected so an agent cannot
 * make ArtiSVN contact arbitrary servers.
 */
export function getAllowedRemoteOriginKeys(): Set<string> {
  const keys = new Set<string>(listCredentialOriginKeys())
  for (const remote of ensureRemotesSeeded()) {
    const key = credentialOriginKeyFromUrl(remote.url)
    if (key) keys.add(key)
  }
  return keys
}

export function resolveRemoteTarget(input: { remoteId?: string; url?: string }): string {
  if (input.remoteId) {
    const remote = ensureRemotesSeeded().find((candidate: StoredRemote) => candidate.id === input.remoteId)
    if (!remote) throw new Error('Repositorio remoto no encontrado')
    return remote.url
  }
  if (input.url) {
    const safeUrl = validateReadOnlyRemoteUrl(input.url)
    const key = credentialOriginKeyFromUrl(safeUrl)
    if (!key || !getAllowedRemoteOriginKeys().has(key)) {
      throw new Error('La URL no pertenece a un servidor SVN configurado en ArtiSVN')
    }
    return safeUrl
  }
  throw new Error('Se requiere remoteId o url')
}

export { SvnCancelledError }
