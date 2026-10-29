import { BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'
import { rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { BASE_REPO_PATH } from '../services/local-paths'
import { buildRepoId } from '../services/read-contract'
import {
  listLocalRepos,
  listLocalReposEnriched,
  localBlame,
  localDiff,
  localFileContent,
  localLog,
  localRevisionFileDiff,
  localRevisionFileSnapshot,
  localStatus,
  repoMetadata,
  svnInfo,
  type LocalRepoSummary
} from '../services/read-ops'
import { discoverLocalRepos } from '../services/local-repos'
import { runSvn, invalidateWorkingCopyOrigin } from '../services/svn-runtime'
import { checkoutRemoteToLocalRepo, sanitizeLocalRepoName } from '../services/checkout'
import { updateLocalRepo } from '../services/update'
import { commitSelectedPaths, revertSelectedPaths } from '../services/commit'
import {
  addPath,
  getConflictContent,
  ignorePath,
  resolveConflict,
  restorePathAtRevision
} from '../services/wc-actions'
import { assertManagedRepoPath, isPhysicallyInsideAny, readFileBounded, resolvePhysicalRepoTarget } from '../services/path-guard'
import { detectEditors, openRepoInEditor } from '../services/editors'
import { getAllowedOpenRoots } from './allowed-roots'
import {
  handleTrusted,
  optionalPositiveInt,
  requirePositiveInt,
  requireString,
  requireStringArray
} from './guard'

/** Max size of a local file sent to the renderer for PDF/DOCX/image preview. */
export const MAX_PREVIEW_BYTES = 100 * 1024 * 1024

function managedRepo(repoPath: unknown): string {
  return assertManagedRepoPath(requireString(repoPath, 'repoPath'), BASE_REPO_PATH)
}

function sendToWindow(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function getEventWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

let enrichmentRunning: Promise<void> | null = null

/** Refreshes metadata in the background and pushes `repos:updated` per repository. */
export function scheduleRepoEnrichment(): void {
  if (enrichmentRunning) return
  enrichmentRunning = listLocalReposEnriched({
    includeStatus: true,
    onUpdate: (repo) => broadcast('repos:updated', repo)
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => { enrichmentRunning = null })
}

/** After a mutating operation, refresh one repository and notify every window. */
function refreshRepoAfterChange(repoPath: string): void {
  const repo = discoverLocalRepos(BASE_REPO_PATH).find((candidate) => candidate.path === repoPath)
  if (!repo) return
  repoMetadata.invalidateStatus(repo.id)
  void repoMetadata.enrich(repo, { includeStatus: true })
    .then((updated: LocalRepoSummary) => broadcast('repos:updated', updated))
    .catch(() => undefined)
}

function buildLocalRepoDeleteError(repoPath: string, error: unknown): Error {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code || '').toUpperCase()
    : ''
  const repoName = basename(repoPath) || 'la copia local'
  if (['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(code)) {
    return new Error(
      `No se pudo eliminar la copia local "${repoName}" porque está en uso. ` +
      'Cierra Explorer, terminales o editores abiertos dentro de esa carpeta e inténtalo de nuevo.'
    )
  }
  const message = error instanceof Error ? String(error.message || '').trim() : ''
  return new Error(message
    ? `No se pudo eliminar la copia local "${repoName}": ${message}`
    : `No se pudo eliminar la copia local "${repoName}".`)
}

export function buildPreviewFromPhysicalFile(physicalPath: string, name: string): { name: string; base64: string } {
  const read = readFileBounded(physicalPath, MAX_PREVIEW_BYTES)
  if (read.truncated) throw new Error('El archivo es demasiado grande para previsualizarlo')
  const safeName = basename(String(name || '').trim()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'preview.bin'
  return { name: safeName, base64: read.buffer.toString('base64') }
}

export function registerRepoIpc(): void {
  handleTrusted('repos:list', async () => {
    const repos = await listLocalRepos()
    scheduleRepoEnrichment()
    return repos
  })

  handleTrusted('repos:basePath', () => BASE_REPO_PATH)

  handleTrusted('repos:delete', async (_event, repoPath: unknown) => {
    const safePath = managedRepo(repoPath)
    try {
      await rm(safePath, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
      repoMetadata.invalidate(buildRepoId(safePath))
      invalidateWorkingCopyOrigin(safePath)
    } catch (error) {
      throw buildLocalRepoDeleteError(safePath, error)
    }
  })

  handleTrusted('svn:checkout', async (event, url: unknown, targetName: unknown) => {
    const targetWindow = getEventWindow(event)
    const result = await checkoutRemoteToLocalRepo(
      requireString(url, 'url'),
      sanitizeLocalRepoName(requireString(targetName, 'targetName', 255)),
      {
        onData: (chunk) => sendToWindow(targetWindow, 'svn:checkout-progress', chunk),
        onErrorData: (chunk) => sendToWindow(targetWindow, 'svn:checkout-progress', chunk)
      }
    )
    scheduleRepoEnrichment()
    return result
  })

  handleTrusted('svn:update', async (event, repoPath: unknown) => {
    const safePath = managedRepo(repoPath)
    const targetWindow = getEventWindow(event)
    try {
      return await updateLocalRepo(safePath, {
        onData: (chunk) => sendToWindow(targetWindow, 'svn:update-progress', chunk),
        onErrorData: (chunk) => sendToWindow(targetWindow, 'svn:update-progress', chunk)
      })
    } finally {
      refreshRepoAfterChange(safePath)
    }
  })

  handleTrusted('svn:cleanup', async (_event, repoPath: unknown) => {
    const safePath = managedRepo(repoPath)
    try {
      const { stdout, stderr } = await runSvn(['cleanup', '.'], { cwd: safePath, skipAuth: true, timeoutMs: 5 * 60 * 1000 })
      return { success: true, output: stdout || stderr }
    } catch (err) {
      const msg = err instanceof Error ? String(err.message || '').trim() : ''
      throw new Error(msg || 'No se pudo limpiar la working copy')
    } finally {
      refreshRepoAfterChange(safePath)
    }
  })

  handleTrusted('svn:status', async (_event, repoPath: unknown) => localStatus(managedRepo(repoPath)))

  handleTrusted('svn:fileContent', async (_event, repoPath: unknown, filePath: unknown) =>
    localFileContent(managedRepo(repoPath), requireString(filePath, 'filePath')).text)

  handleTrusted('svn:getLocalPreviewFile', async (_event, repoPath: unknown, filePath: unknown) => {
    const physical = resolvePhysicalRepoTarget(managedRepo(repoPath), requireString(filePath, 'filePath'), { mustExist: true })
    if (!statSync(physical.targetReal).isFile()) throw new Error('Solo se pueden previsualizar archivos')
    return buildPreviewFromPhysicalFile(physical.targetReal, basename(physical.targetAbs))
  })

  handleTrusted('svn:getConflictContent', async (_event, repoPath: unknown, filePath: unknown) =>
    getConflictContent(managedRepo(repoPath), requireString(filePath, 'filePath')))

  handleTrusted('svn:diff', async (_event, repoPath: unknown, filePath: unknown) =>
    (await localDiff(managedRepo(repoPath), requireString(filePath, 'filePath'))).text)

  handleTrusted('svn:add', async (_event, repoPath: unknown, filePath: unknown, scope: unknown) => {
    const safePath = managedRepo(repoPath)
    const result = await addPath(safePath, requireString(filePath, 'filePath'), scope === 'branch' ? 'branch' : 'item')
    refreshRepoAfterChange(safePath)
    return result
  })

  handleTrusted('svn:ignore', async (_event, repoPath: unknown, filePath: unknown, scope: unknown) => {
    const safePath = managedRepo(repoPath)
    const result = await ignorePath(safePath, requireString(filePath, 'filePath'), scope === 'branch' ? 'branch' : 'item')
    refreshRepoAfterChange(safePath)
    return result
  })

  handleTrusted('svn:blame', async (_event, repoPath: unknown, filePath: unknown) =>
    localBlame(managedRepo(repoPath), requireString(filePath, 'filePath')))

  handleTrusted('svn:revisionFileDiff', async (_event, repoPath: unknown, revision: unknown, svnPath: unknown) =>
    (await localRevisionFileDiff(managedRepo(repoPath), requirePositiveInt(revision, 'revision'), requireString(svnPath, 'svnPath'))).text)

  // Full read-only snapshot of a file exactly at `revision` (never HEAD / working copy).
  handleTrusted('svn:revisionFileContent', async (_event, repoPath: unknown, revision: unknown, svnPath: unknown) =>
    localRevisionFileSnapshot(managedRepo(repoPath), requirePositiveInt(revision, 'revision'), requireString(svnPath, 'svnPath')))

  handleTrusted('svn:restorePathAtRevision', async (
    _event,
    repoPath: unknown,
    revision: unknown,
    svnPath: unknown,
    action: unknown
  ) => {
    const safePath = managedRepo(repoPath)
    const result = await restorePathAtRevision(
      safePath,
      requirePositiveInt(revision, 'revision'),
      requireString(svnPath, 'svnPath'),
      typeof action === 'string' ? action : 'M'
    )
    refreshRepoAfterChange(safePath)
    return result
  })

  handleTrusted('svn:commit', async (_event, repoPath: unknown, files: unknown, message: unknown) => {
    const safePath = managedRepo(repoPath)
    try {
      const result = await commitSelectedPaths(safePath, requireStringArray(files, 'files'), requireString(message, 'message', 100_000), runSvn)
      return { success: true, output: result.output }
    } finally {
      refreshRepoAfterChange(safePath)
    }
  })

  handleTrusted('svn:revert', async (_event, repoPath: unknown, files: unknown) => {
    const safePath = managedRepo(repoPath)
    try {
      return await revertSelectedPaths(safePath, requireStringArray(files, 'files'), runSvn)
    } finally {
      refreshRepoAfterChange(safePath)
    }
  })

  handleTrusted('svn:resolve', async (_event, repoPath: unknown, filePath: unknown, accept: unknown) => {
    const safePath = managedRepo(repoPath)
    const result = await resolveConflict(safePath, requireString(filePath, 'filePath'), String(accept || ''))
    refreshRepoAfterChange(safePath)
    return result
  })

  handleTrusted('svn:log', async (_event, repoPath: unknown, limit: unknown, fromRevision: unknown) =>
    localLog(managedRepo(repoPath), Number(limit) || 50, optionalPositiveInt(fromRevision, 'fromRevision')))

  handleTrusted('svn:info', async (_event, path: unknown) => svnInfo(managedRepo(path)))

  handleTrusted('dialog:openFile', async (_event, repoPath: unknown, filePath: unknown) => {
    const physical = resolvePhysicalRepoTarget(managedRepo(repoPath), requireString(filePath, 'filePath'), { mustExist: true })
    const error = await shell.openPath(physical.targetReal)
    if (error) throw new Error(error)
  })

  handleTrusted('dialog:openFolder', async (_event, path: unknown) => {
    const safePath = requireString(path, 'path')
    if (!existsSync(safePath)) throw new Error('La carpeta no existe')
    if (!isPhysicallyInsideAny(safePath, [BASE_REPO_PATH, ...getAllowedOpenRoots()])) {
      throw new Error('Solo se pueden abrir carpetas de ArtiSVN o destinos elegidos en esta sesión')
    }
    const target = statSync(safePath).isDirectory() ? safePath : undefined
    if (target) {
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
    } else {
      shell.showItemInFolder(safePath)
    }
  })

  handleTrusted('dialog:listEditors', async () => detectEditors().map(({ id, label }) => ({ id, label })))

  handleTrusted('dialog:openInEditor', async (_event, editorId: unknown, repoPath: unknown) => {
    const safeEditorId = typeof editorId === 'string' ? editorId.trim() : ''
    if (safeEditorId !== 'vscode' && safeEditorId !== 'vscode-insiders') throw new Error('Editor no soportado')
    openRepoInEditor(safeEditorId, managedRepo(repoPath))
    return true
  })
}
