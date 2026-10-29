import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { runSvn } from '../services/svn-runtime'
import { EXPORT_EXTERNALS_NOTICE } from '../services/externals'
import {
  listRemote,
  remoteFileContent,
  remoteLog,
  remoteRepoRoot,
  remoteRevisionDiff,
  remoteRevisionFileSnapshot,
  searchRemote
} from '../services/read-ops'
import { validateReadOnlyRemoteUrl } from '../services/read-contract'
import { getInvalidLocalEntryNameReason } from '../services/checkout-contract'
import { isLexicallyInside } from '../services/path-guard'
import { allowUserChosenRoot, getAllowedOpenRoots } from './allowed-roots'
import { buildPreviewFromPhysicalFile, MAX_PREVIEW_BYTES } from './repo-ipc'
import { handleTrusted, optionalString, requirePositiveInt, requireString } from './guard'

function getEventWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function sendToWindow(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function safeUrl(value: unknown, name = 'url'): string {
  return validateReadOnlyRemoteUrl(requireString(value, name, 8192))
}

function validEntryName(value: unknown): string {
  const name = requireString(value, 'name', 255).trim()
  const reason = getInvalidLocalEntryNameReason(name)
  if (reason) throw new Error(`Nombre inválido (${reason})`)
  return name
}

function buildRemoteUrl(parentUrl: string, name: string): string {
  return `${parentUrl.replace(/\/$/, '')}/${encodeURIComponent(name)}`
}

const previewTempDirs = new Set<string>()

export function cleanupPreviewTempDirs(): void {
  for (const dir of previewTempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  previewTempDirs.clear()
}

async function exportRemotePreviewFile(url: string, suggestedName?: string): Promise<{ name: string; base64: string }> {
  const fallbackName = basename(url.replace(/\/+$/g, '')) || 'preview.bin'
  const safeName = basename(String(suggestedName || fallbackName)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'preview.bin'
  const previewDir = mkdtempSync(join(tmpdir(), 'artisvn-preview-'))
  previewTempDirs.add(previewDir)
  const targetPath = join(previewDir, safeName)
  try {
    await runSvn(['export', '--force', '--', url, targetPath], { timeoutMs: 5 * 60 * 1000 })
    if (statSync(targetPath).size > MAX_PREVIEW_BYTES) {
      throw new Error('El archivo es demasiado grande para previsualizarlo')
    }
    return buildPreviewFromPhysicalFile(targetPath, safeName)
  } finally {
    try { rmSync(previewDir, { recursive: true, force: true }) } catch { /* ignore */ }
    previewTempDirs.delete(previewDir)
  }
}

/** One active search per renderer; a new search or `svn:cancelSearch` aborts the previous one. */
const activeSearches = new Map<number, AbortController>()

export function registerRemoteIpc(): void {
  handleTrusted('svn:list', async (_event, url: unknown) => listRemote(safeUrl(url)))

  handleTrusted('svn:searchRemote', async (event, url: unknown, query: unknown, deepSearch: unknown) => {
    const senderId = event.sender.id
    activeSearches.get(senderId)?.abort()
    const controller = new AbortController()
    activeSearches.set(senderId, controller)
    const sender = event.sender
    const onDestroyed = () => controller.abort()
    sender.once('destroyed', onDestroyed)
    const send = (channel: string, payload: unknown) => {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    }

    try {
      const response = await searchRemote(safeUrl(url), requireString(query, 'query', 1000), Boolean(deepSearch), {
        onProgress: (progress) => send('svn:searchProgress', progress),
        onResult: (result) => send('svn:searchResult', result),
        maxResults: 500,
        signal: controller.signal
      })
      send('svn:searchDone', {
        searched: response.searched,
        total: response.total,
        truncated: response.truncated,
        stopReason: response.stopReason
      })
      return { ok: true, truncated: response.truncated, stopReason: response.stopReason }
    } finally {
      sender.removeListener('destroyed', onDestroyed)
      if (activeSearches.get(senderId) === controller) activeSearches.delete(senderId)
    }
  })

  handleTrusted('svn:cancelSearch', async (event) => {
    activeSearches.get(event.sender.id)?.abort()
    return true
  })

  handleTrusted('svn:remoteLog', async (_event, url: unknown, limit: unknown) => remoteLog(safeUrl(url), Number(limit) || 50))

  handleTrusted('svn:remoteMkdir', async (_event, parentUrl: unknown, name: unknown, message: unknown) => {
    const safeName = validEntryName(name)
    const targetUrl = buildRemoteUrl(safeUrl(parentUrl, 'parentUrl'), safeName)
    const msg = (optionalString(message, 'message', 100_000) || '').trim() || `Crear carpeta ${safeName}`
    const { stdout } = await runSvn(['mkdir', '--force-log', '-m', msg, '--', targetUrl], { timeoutMs: 30000 })
    return { success: true, url: targetUrl, output: stdout }
  })

  handleTrusted('svn:remoteCreateFile', async (
    _event,
    parentUrl: unknown,
    name: unknown,
    content: unknown,
    message: unknown
  ) => {
    const safeName = validEntryName(name)
    const targetUrl = buildRemoteUrl(safeUrl(parentUrl, 'parentUrl'), safeName)
    const msg = (optionalString(message, 'message', 100_000) || '').trim() || `Crear archivo ${safeName}`
    const body = optionalString(content, 'content', 10 * 1024 * 1024) || ''

    const tempDir = mkdtempSync(join(tmpdir(), 'artisvn-'))
    const tempFile = join(tempDir, safeName)
    if (!isLexicallyInside(tempDir, tempFile) || dirname(tempFile) !== tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      throw new Error('Nombre de archivo inválido')
    }
    writeFileSync(tempFile, body, 'utf-8')
    try {
      const { stdout } = await runSvn(['import', '--force-log', '-m', msg, '--', tempFile, targetUrl], { timeoutMs: 30000 })
      return { success: true, url: targetUrl, output: stdout }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  handleTrusted('svn:export', async (event, url: unknown, targetPath: unknown) => {
    const safeTarget = requireString(targetPath, 'targetPath')
    // The parent must be a folder the user picked with the native dialog.
    let parentReal = ''
    try {
      parentReal = realpathSync.native(dirname(safeTarget))
    } catch {
      parentReal = ''
    }
    if (!parentReal || !getAllowedOpenRoots().includes(parentReal)) {
      throw new Error('Elige la carpeta de destino con el selector antes de exportar')
    }
    validEntryName(basename(safeTarget))
    if (existsSync(safeTarget)) throw new Error(`Ya existe una carpeta en "${safeTarget}"`)

    const targetWindow = getEventWindow(event)
    try {
      await runSvn(['export', '--', safeUrl(url), safeTarget], {
        idleTimeoutMs: 15 * 60 * 1000,
        onData: (chunk) => sendToWindow(targetWindow, 'svn:export-progress', chunk),
        onErrorData: (chunk) => sendToWindow(targetWindow, 'svn:export-progress', chunk)
      })
      // Exports always run with --ignore-externals (svn-policy); tell the user.
      sendToWindow(targetWindow, 'svn:export-progress', `${EXPORT_EXTERNALS_NOTICE}\n`)
      allowUserChosenRoot(safeTarget)
      return { success: true, path: safeTarget }
    } catch (err) {
      const msg = err instanceof Error ? String(err.message || '').trim() : ''
      throw new Error(msg || 'Error al exportar el repositorio')
    }
  })

  handleTrusted('svn:downloadFile', async (event, url: unknown, defaultName: unknown) => {
    const remoteUrl = safeUrl(url)
    const owner = getEventWindow(event)
    const options = {
      title: 'Guardar archivo',
      defaultPath: basename(String(defaultName || '')) || undefined,
      buttonLabel: 'Guardar'
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await runSvn(['export', '--force', '--', remoteUrl, result.filePath], { timeoutMs: 30 * 60 * 1000 })
      return { success: true, path: result.filePath }
    } catch (err) {
      const msg = err instanceof Error ? String(err.message || '').trim() : ''
      throw new Error(msg || 'Error al descargar el archivo')
    }
  })

  handleTrusted('dialog:pickExportFolder', async (event) => {
    const owner = getEventWindow(event)
    const options = {
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      title: 'Seleccionar carpeta de destino',
      buttonLabel: 'Seleccionar'
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    allowUserChosenRoot(result.filePaths[0])
    return result.filePaths[0]
  })

  handleTrusted('svn:getRemotePreviewFile', async (_event, url: unknown, defaultName: unknown) =>
    exportRemotePreviewFile(safeUrl(url), optionalString(defaultName, 'defaultName', 1024)))

  handleTrusted('svn:cat', async (_event, url: unknown) => (await remoteFileContent(safeUrl(url))).text)

  handleTrusted('svn:getRepoRoot', async (_event, url: unknown) => remoteRepoRoot(safeUrl(url)))

  // Full read-only snapshot of a file exactly at `revision` (repository root resolved from baseUrl).
  handleTrusted('svn:remoteRevisionFileContent', async (_event, baseUrl: unknown, svnPath: unknown, revision: unknown) =>
    remoteRevisionFileSnapshot(safeUrl(baseUrl, 'baseUrl'), requireString(svnPath, 'svnPath'), requirePositiveInt(revision, 'revision')))

  handleTrusted('svn:remoteRevisionDiff', async (_event, baseUrl: unknown, svnPath: unknown, revision: unknown) =>
    (await remoteRevisionDiff(safeUrl(baseUrl, 'baseUrl'), requireString(svnPath, 'svnPath'), requirePositiveInt(revision, 'revision'))).text)
}
