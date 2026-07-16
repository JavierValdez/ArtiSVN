import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { setupAppUpdater } from './updater'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { createRequire } from 'module'
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'os'
import {
  deleteRemote,
  getCurrentServerUrl,
  getStoredCredentials,
  listRemotes,
  renameRemote,
  saveRemote,
  selectRemote,
  setCurrentServerUrl,
  storeDelete,
  writeStoredCredentials
} from './services/store'
import {
  getSvnBin,
  getSvnBinInfo,
  runSvn,
  setSvnBin,
  buildInlineAuthArgs
} from './services/svn-runtime'
import {
  BASE_REPO_PATH,
  listLocalRepos as listLocalReposService,
  listRemote as listRemoteService,
  localBlame as localBlameService,
  localDiff as localDiffService,
  localFileContent as localFileContentService,
  localLog as localLogService,
  localRevisionFileDiff as localRevisionFileDiffService,
  localStatus as localStatusService,
  remoteFileContent as remoteFileContentService,
  remoteLog as remoteLogService,
  remoteRepoRoot as remoteRepoRootService,
  remoteRevisionDiff as remoteRevisionDiffService,
  searchRemote as searchRemoteService,
  svnInfo as svnInfoService
} from './services/read-ops'
import {
  checkoutRemoteToLocalRepo,
  sanitizeLocalRepoName
} from './services/checkout'
import { updateLocalRepo } from './services/update'
import {
  clearAgentActivity,
  getAgentClientConfig,
  getAgentIntegrationPublicState,
  regenerateAgentIntegrationPublicToken,
  setAgentIntegrationPublicEnabled,
  startAgentBrokerIfEnabled,
  stopAgentBroker
} from './agent/integration'
import { runMcpServerMode } from './agent/mcp-server'
import { MCP_ENV, resolveMcpEnv } from './agent/identity'
import {
  inspectAppMigration,
  runAppMigrationAction,
  type MigrationAction
} from './services/app-migration'

const _require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xml2js = _require('xml2js') as any
const parseStringPromise = xml2js.parseStringPromise

const isDev = process.env.NODE_ENV === 'development'
const mcpStdioValue = resolveMcpEnv(process.env, MCP_ENV.stdio, MCP_ENV.legacyStdio)
const mcpTokenValue = resolveMcpEnv(process.env, MCP_ENV.token, MCP_ENV.legacyToken)
const isMcpStdioMode = process.argv.includes('--mcp-stdio')
  || mcpStdioValue === '1'
  || Boolean(mcpTokenValue)

// Set app name before ready so it shows correctly in the dock and menu bar.
app.name = 'ArtiSVN'

function getAppMigrationOptions() {
  return {
    appDataPath: app.getPath('appData'),
    documentsPath: dirname(BASE_REPO_PATH),
  }
}

async function startAgentBrokerWhenMigrationResolved(): Promise<void> {
  if (!inspectAppMigration(getAppMigrationOptions()).needed) {
    await startAgentBrokerIfEnabled()
  }
}

if (isMcpStdioMode) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory')
  }
}

function getExtraPathSegments(): string {
  if (process.platform === 'win32') {
    const pf   = process.env.ProgramFiles        || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    return [join(pf, 'TortoiseSVN', 'bin'), join(pf86, 'TortoiseSVN', 'bin')].join(';')
  }
  return '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
}

// ─── Store & Paths ────────────────────────────────────────────────────────────

if (!existsSync(BASE_REPO_PATH)) {
  mkdirSync(BASE_REPO_PATH, { recursive: true })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readUtf8IfExists(path: string): string {
  try {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

function isRepositoryPath(pathValue: string): boolean {
  const relativePath = relative(resolve(BASE_REPO_PATH), resolve(pathValue))
  if (!relativePath || isAbsolute(relativePath)) return false
  return relativePath.split(/[\\/]/)[0] !== '..'
}

function resolveRepoRelativeTarget(repoPath: string, filePath: string): {
  repoAbs: string
  targetAbs: string
  relativePath: string
} {
  const repoAbs = resolve(repoPath)
  const targetAbs = resolve(repoPath, filePath)
  const relativePath = relative(repoAbs, targetAbs)

  if (relativePath.split(/[\\/]/)[0] === '..' || isAbsolute(relativePath)) {
    throw new Error('Ruta fuera del repositorio')
  }

  return { repoAbs, targetAbs, relativePath }
}

function normalizeRelativePath(input: string): string {
  return String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

function toRepoRelativeArg(relPath: string): string {
  return normalizeRelativePath(relPath) || '.'
}

function getParentRelativePath(relPath: string): string {
  const normalized = normalizeRelativePath(relPath)
  if (!normalized) return ''
  const parent = dirname(normalized).replace(/\\/g, '/')
  return parent === '.' ? '' : normalizeRelativePath(parent)
}

function splitRelativeSegments(relPath: string): string[] {
  return normalizeRelativePath(relPath).split('/').filter(Boolean)
}

function normalizeSvnRepoPath(input: string): string {
  const normalized = String(input || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '')
  if (!normalized || normalized === '.') return ''
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function getRepoPathFromSvnUrl(url: string): string {
  const safeUrl = String(url || '').trim()
  if (!safeUrl) return ''

  try {
    return normalizeSvnRepoPath(decodeURIComponent(new URL(safeUrl).pathname))
  } catch {
    return normalizeSvnRepoPath(safeUrl)
  }
}

function getWorkingCopyScopePath(info: { url: string; rootUrl: string }): string {
  const urlPath = getRepoPathFromSvnUrl(info.url)
  const rootPath = getRepoPathFromSvnUrl(info.rootUrl)

  if (!urlPath || !rootPath) return ''
  if (urlPath === rootPath) return ''
  if (!urlPath.startsWith(`${rootPath}/`)) return ''
  return normalizeSvnRepoPath(urlPath.slice(rootPath.length))
}

function mapRepoPathToWorkingCopyRelativePath(repoScopedPath: string, workingCopyScope: string): string | null {
  const normalizedRepoPath = normalizeSvnRepoPath(repoScopedPath)
  const normalizedScope = normalizeSvnRepoPath(workingCopyScope)

  if (!normalizedRepoPath) return null
  if (!normalizedScope) return normalizeRelativePath(normalizedRepoPath)
  if (normalizedRepoPath === normalizedScope) return ''
  if (!normalizedRepoPath.startsWith(`${normalizedScope}/`)) return null

  return normalizeRelativePath(normalizedRepoPath.slice(normalizedScope.length))
}

async function isVersionedWorkingCopyPath(repoPath: string, relPath: string): Promise<boolean> {
  try {
    await runSvn(['info', '--xml', toRepoRelativeArg(relPath)], {
      cwd: repoPath,
      timeoutMs: 10000
    })
    return true
  } catch {
    return false
  }
}

async function findNearestVersionedDirectory(repoPath: string, startRelPath: string): Promise<string> {
  let current = normalizeRelativePath(startRelPath)

  while (true) {
    if (await isVersionedWorkingCopyPath(repoPath, current)) {
      return current
    }

    if (!current) {
      break
    }

    current = getParentRelativePath(current)
  }

  throw new Error('No se encontró una carpeta versionada para aplicar la acción')
}

async function resolveUnversionedBranchTarget(repoPath: string, targetRelPath: string): Promise<{
  versionedAncestorRelPath: string
  branchRelPath: string
  branchName: string
}> {
  const normalizedTarget = normalizeRelativePath(targetRelPath)
  if (!normalizedTarget) {
    throw new Error('No se puede aplicar la acción sobre la raíz del repositorio')
  }

  const versionedAncestorRelPath = await findNearestVersionedDirectory(
    repoPath,
    getParentRelativePath(normalizedTarget)
  )
  const targetSegments = splitRelativeSegments(normalizedTarget)
  const ancestorSegments = splitRelativeSegments(versionedAncestorRelPath)
  const branchName = targetSegments[ancestorSegments.length]

  if (!branchName) {
    throw new Error('No se pudo determinar la rama/carpeta a procesar')
  }

  const branchRelPath = normalizeRelativePath(
    ancestorSegments.length > 0
      ? `${ancestorSegments.join('/')}/${branchName}`
      : branchName
  )

  return { versionedAncestorRelPath, branchRelPath, branchName }
}

async function readIgnorePatterns(repoPath: string, dirRelPath: string): Promise<string[]> {
  try {
    const { stdout } = await runSvn(['propget', 'svn:ignore', toRepoRelativeArg(dirRelPath)], {
      cwd: repoPath,
      timeoutMs: 10000
    })

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function appendIgnorePattern(repoPath: string, dirRelPath: string, pattern: string): Promise<{
  alreadyPresent: boolean
  propertyTarget: string
}> {
  const nextPattern = String(pattern || '').trim()
  if (!nextPattern) {
    throw new Error('El patrón a ignorar es requerido')
  }

  const propertyTarget = normalizeRelativePath(dirRelPath)
  const existingPatterns = await readIgnorePatterns(repoPath, propertyTarget)
  if (existingPatterns.includes(nextPattern)) {
    return {
      alreadyPresent: true,
      propertyTarget: propertyTarget || '.'
    }
  }

  const updatedValue = [...existingPatterns, nextPattern].join('\n')
  await runSvn(['propset', 'svn:ignore', updatedValue, toRepoRelativeArg(propertyTarget)], {
    cwd: repoPath,
    timeoutMs: 10000
  })

  return {
    alreadyPresent: false,
    propertyTarget: propertyTarget || '.'
  }
}

function sanitizePreviewFileName(value: string, fallback = 'preview.bin'): string {
  const baseName = basename(String(value || '').trim()) || fallback
  const sanitized = baseName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return sanitized || fallback
}

function buildPreviewFileResponse(filePath: string, name?: string): { name: string; base64: string } {
  const safeName = sanitizePreviewFileName(name || basename(filePath))
  const buf = readFileSync(filePath)
  return { name: safeName, base64: buf.toString('base64') }
}

const previewTempDirs: string[] = []

function cleanupPreviewTempDirs(): void {
  for (const dir of previewTempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  previewTempDirs.length = 0
}

async function exportRemotePreviewFile(url: string, suggestedName?: string): Promise<{ name: string; base64: string }> {
  const safeUrl = String(url || '').trim()
  if (!safeUrl) throw new Error('La URL del archivo es requerida')

  const fallbackName = basename(safeUrl.replace(/\/+$/g, '')) || 'preview.bin'
  const safeName = sanitizePreviewFileName(suggestedName || fallbackName)
  const previewDir = mkdtempSync(join(tmpdir(), 'artisvn-preview-'))
  previewTempDirs.push(previewDir)
  const targetPath = join(previewDir, safeName)

  await runSvn(['export', '--force', safeUrl, targetPath], {
    timeoutMs: 5 * 60 * 1000
  })

  const result = buildPreviewFileResponse(targetPath, safeName)

  // Cleanup temp dir immediately after reading
  try { rmSync(previewDir, { recursive: true, force: true }) } catch { /* ignore */ }
  const idx = previewTempDirs.indexOf(previewDir)
  if (idx >= 0) previewTempDirs.splice(idx, 1)

  return result
}

function isLocalRepoDeleteBusyError(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code || '').toUpperCase()
    : ''
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EACCES'
}

function buildLocalRepoDeleteError(repoPath: string, error: unknown): Error {
  const repoName = basename(repoPath) || 'la copia local'
  if (isLocalRepoDeleteBusyError(error)) {
    return new Error(
      `No se pudo eliminar la copia local "${repoName}" porque está en uso. ` +
      'Cierra Explorer, terminales o editores abiertos dentro de esa carpeta e inténtalo de nuevo.'
    )
  }

  const message = error instanceof Error ? String(error.message || '').trim() : ''
  if (message) {
    return new Error(`No se pudo eliminar la copia local "${repoName}": ${message}`)
  }
  return new Error(`No se pudo eliminar la copia local "${repoName}".`)
}

// ─── Find svn binary ─────────────────────────────────────────────────────────
function buildEnvWithExtraPath(): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const extra = getExtraPathSegments()
  const current = process.env[pathKey] || process.env.PATH || ''
  const firstSegment = extra.split(sep)[0] || ''
  const merged = (firstSegment && current.includes(firstSegment)) ? current : `${extra}${sep}${current}`
  return { ...process.env, [pathKey]: merged, PATH: merged }
}

type SupportedEditorId = 'vscode' | 'vscode-insiders'

interface DetectedEditor {
  id: SupportedEditorId
  label: string
  command?: string
  macAppPath?: string
  winExecutablePath?: string
}

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(locator, [command], {
    env: buildEnvWithExtraPath(),
    stdio: 'ignore',
    windowsHide: true,
    timeout: 3000
  })
  return !result.error && result.status === 0
}

function firstExistingPath(paths: string[]): string | undefined {
  for (const path of paths) {
    if (path && existsSync(path)) return path
  }
  return undefined
}

function detectEditors(): DetectedEditor[] {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

  const definitions: Array<{
    id: SupportedEditorId
    label: string
    command: string
    macAppName: string
    winCandidates: string[]
  }> = [
    {
      id: 'vscode',
      label: 'VS Code',
      command: 'code',
      macAppName: 'Visual Studio Code.app',
      winCandidates: [
        join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        join(programFiles, 'Microsoft VS Code', 'Code.exe'),
        join(programFilesX86, 'Microsoft VS Code', 'Code.exe')
      ]
    },
    {
      id: 'vscode-insiders',
      label: 'VS Code Insiders',
      command: 'code-insiders',
      macAppName: 'Visual Studio Code - Insiders.app',
      winCandidates: [
        join(localAppData, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
        join(programFiles, 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
        join(programFilesX86, 'Microsoft VS Code Insiders', 'Code - Insiders.exe')
      ]
    }
  ]

  return definitions
    .map((editor) => {
      const command = commandExists(editor.command) ? editor.command : undefined
      const macAppPath = process.platform === 'darwin'
        ? firstExistingPath([
          join('/Applications', editor.macAppName),
          join(homedir(), 'Applications', editor.macAppName)
        ])
        : undefined
      const winExecutablePath = process.platform === 'win32'
        ? firstExistingPath(editor.winCandidates)
        : undefined

      if (!command && !macAppPath && !winExecutablePath) return null
      return {
        id: editor.id,
        label: editor.label,
        command,
        macAppPath,
        winExecutablePath
      } as DetectedEditor
    })
    .filter((x): x is DetectedEditor => x !== null)
}

function buildEditorLaunchEnv(): NodeJS.ProcessEnv {
  const env = { ...buildEnvWithExtraPath() }

  // Avoid leaking Electron/VS Code process state into a fresh VS Code launch.
  for (const key of Object.keys(env)) {
    if (key === 'ELECTRON_ENABLE_LOGGING' || key === 'ELECTRON_ENABLE_STACK_DUMPING') continue
    if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
      delete env[key]
    }
  }

  return env
}

function runCommand(command: string, args: string[], options: { shell?: boolean } = {}): boolean {
  try {
    const proc = spawn(command, args, {
      env: buildEditorLaunchEnv(),
      stdio: 'ignore',
      windowsHide: true,
      shell: options.shell || false,
      detached: true
    })

    proc.unref()
    return Boolean(proc.pid)
  } catch {
    return false
  }
}

function openRepoInEditor(editorId: SupportedEditorId, repoPath: string): void {
  const safePath = (repoPath || '').trim()
  if (!safePath) throw new Error('Ruta de repositorio inválida')
  if (!existsSync(safePath)) throw new Error('El repositorio no existe')
  if (!statSync(safePath).isDirectory()) throw new Error('La ruta no es una carpeta')

  const editor = detectEditors().find((x) => x.id === editorId)
  if (!editor) throw new Error('Ese editor no está disponible en este equipo')

  // On Windows, prefer launching the detected .exe directly to avoid shell arg splitting
  // when repository paths contain spaces.
  if (process.platform === 'win32') {
    if (editor.winExecutablePath && runCommand(editor.winExecutablePath, [safePath])) return
    if (editor.command && runCommand(editor.command, [safePath], { shell: true })) return
  } else {
    if (editor.command && runCommand(editor.command, [safePath])) return
    if (process.platform === 'darwin' && editor.macAppPath && runCommand('open', ['-a', editor.macAppPath, safePath])) return
  }

  throw new Error(`No se pudo abrir el repositorio en ${editor.label}`)
}

// ─── Main Window ─────────────────────────────────────────────────────────────
function sendToWindow(window: BrowserWindow | null, channel: string, payload: string): void {
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function getEventWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function createWindow(sourceWindow?: BrowserWindow | null): BrowserWindow {
  const preloadCandidates = [
    join(__dirname, '../preload/index.mjs'),
    join(__dirname, '../preload/index.js')
  ]
  const preloadPath = preloadCandidates.find((p) => existsSync(p)) || preloadCandidates[0]

  const windowsIconCandidates = [
    join(app.getAppPath(), 'resources', 'icon.ico'),
    join(process.resourcesPath, 'icon.ico'),
    join(__dirname, '../../resources/icon.ico')
  ]
  const windowsIconPath = process.platform === 'win32'
    ? windowsIconCandidates.find((p) => existsSync(p))
    : undefined

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#ffffff',
    ...(windowsIconPath ? { icon: windowsIconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      sandbox: false
    }
  })

  const shouldMaximize = Boolean(sourceWindow && !sourceWindow.isDestroyed() && sourceWindow.isMaximized())
  if (sourceWindow && !sourceWindow.isDestroyed() && !shouldMaximize) {
    const [x, y] = sourceWindow.getPosition()
    const [width, height] = sourceWindow.getSize()
    window.setBounds({
      x: x + 28,
      y: y + 28,
      width,
      height
    })
  }

  window.on('ready-to-show', () => {
    if (shouldMaximize) window.maximize()
    window.show()
    setupAppUpdater(window)
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function openNewWindow(sourceWindow?: BrowserWindow | null): BrowserWindow {
  const referenceWindow = sourceWindow && !sourceWindow.isDestroyed()
    ? sourceWindow
    : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  return createWindow(referenceWindow)
}

function buildDockMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Nueva ventana',
      click: () => {
        openNewWindow()
      }
    }
  ])
}

function setupDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  app.dock.setMenu(buildDockMenu())
}

function setupApplicationMenu(): void {
  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Nueva ventana',
      accelerator: 'CmdOrCtrl+N',
      click: () => {
        openNewWindow()
      }
    },
    { type: 'separator' },
    process.platform === 'darwin'
      ? { role: 'close', label: 'Cerrar ventana' }
      : { role: 'quit', label: 'Salir' }
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'Archivo',
      submenu: fileSubmenu
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  if (isMcpStdioMode) return
  if (process.platform === 'win32') app.setAppUserModelId('com.artisvn.app')

  // Set dock icon in dev mode (in production the .icns in the bundle is used automatically)
  if (isDev && process.platform === 'darwin' && app.dock) {
    const iconPath = join(app.getAppPath(), 'ico.png')
    if (existsSync(iconPath)) app.dock.setIcon(iconPath)
  }

  setupApplicationMenu()
  setupDockMenu()
  void startAgentBrokerWhenMigrationResolved()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

if (isMcpStdioMode) {
  void runMcpServerMode().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'No se pudo iniciar el MCP de ArtiSVN'}\n`)
    app.exit(1)
  })
}

app.on('window-all-closed', () => {
  cleanupPreviewTempDirs()
  if (isMcpStdioMode) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  cleanupPreviewTempDirs()
  void stopAgentBroker()
})

ipcMain.handle('appMigration:inspect', () => {
  return inspectAppMigration(getAppMigrationOptions())
})

ipcMain.handle('appMigration:runAction', async (_event, action: MigrationAction) => {
  if (action !== 'migrate-now' && action !== 'remind-later' && action !== 'start-without-migration') {
    throw new Error('Acción de migración no soportada')
  }

  const result = runAppMigrationAction(action, getAppMigrationOptions())
  await startAgentBrokerWhenMigrationResolved()
  return result
})

ipcMain.handle('app:newWindow', async (event) => {
  openNewWindow(getEventWindow(event))
  return true
})

ipcMain.handle('agentIntegration:getState', () => {
  return getAgentIntegrationPublicState()
})

ipcMain.handle('agentIntegration:setEnabled', async (_e, enabled: boolean) => {
  return setAgentIntegrationPublicEnabled(Boolean(enabled))
})

ipcMain.handle('agentIntegration:getClientConfig', () => {
  return getAgentClientConfig()
})

ipcMain.handle('agentIntegration:regenerateToken', async () => {
  return regenerateAgentIntegrationPublicToken()
})

ipcMain.handle('agentIntegration:getActivity', () => {
  return getAgentIntegrationPublicState().activity
})

ipcMain.handle('agentIntegration:clearActivity', () => {
  return clearAgentActivity()
})

async function parseXml(xml: string): Promise<any> {
  return parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: false
  })
}

function buildRemoteUrl(parentUrl: string, name: string): string {
  const safeName = (name || '').trim()
  if (!safeName) throw new Error('El nombre es requerido')
  if (safeName.includes('/') || safeName.includes('\\')) {
    throw new Error('El nombre no debe incluir "/" ni "\\"')
  }
  return `${parentUrl.replace(/\/$/, '')}/${encodeURIComponent(safeName)}`
}

// ─── IPC: Credentials ─────────────────────────────────────────────────────────
ipcMain.handle('creds:get', () => {
  return getStoredCredentials() || null
})

ipcMain.handle('creds:set', (_e, creds: { username: string; password: string; serverUrl: string }) => {
  writeStoredCredentials(creds)
  if (creds.serverUrl?.trim()) setCurrentServerUrl(creds.serverUrl.trim())
  return true
})

ipcMain.handle('creds:update', (_e, creds: { username: string; password: string; serverUrl: string }) => {
  const current = getStoredCredentials()
  const updated = {
    username: creds.username.trim(),
    password: creds.password || current?.password || '',
    serverUrl: creds.serverUrl?.trim() || current?.serverUrl || ''
  }
  writeStoredCredentials(updated)
  if (updated.serverUrl) setCurrentServerUrl(updated.serverUrl)
  return true
})

ipcMain.handle('creds:clear', () => {
  storeDelete('credentials')
  return true
})

ipcMain.handle('creds:getServerUrl', () => {
  return getCurrentServerUrl()
})

ipcMain.handle('creds:setServerUrl', (_e, serverUrl: string) => {
  const nextUrl = (serverUrl || '').trim()
  if (!nextUrl) throw new Error('La URL del servidor es requerida')
  setCurrentServerUrl(nextUrl)
  return true
})

// ─── IPC: Remote server tree ─────────────────────────────────────────────────
ipcMain.handle('remotes:list', () => {
  return listRemotes()
})

ipcMain.handle('remotes:save', (_e, payload: { name: string; url: string }) => {
  return saveRemote(payload)
})

ipcMain.handle('remotes:select', (_e, remoteId: string) => {
  return selectRemote(remoteId)
})

ipcMain.handle('remotes:delete', (_e, remoteId: string) => {
  return deleteRemote(remoteId)
})

ipcMain.handle('remotes:rename', (_e, remoteId: string, name: string, url?: string) => {
  return renameRemote(remoteId, name, url)
})

// ─── IPC: SVN binary override (legacy compatibility) ────────────────────────
ipcMain.handle('svn:getBinPath', async () => {
  return getSvnBinInfo()
})

ipcMain.handle('svn:setBinPath', async (_e, binPath: string) => {
  const next = (binPath || '').trim()

  if (!next || next.toLowerCase() === 'auto') {
    storeDelete('svnBinPath')
    return setSvnBin('svn')
  }
  return setSvnBin(next)
})

// ─── IPC: Local Repos ─────────────────────────────────────────────────────────
ipcMain.handle('repos:list', async () => {
  return listLocalReposService()
})

ipcMain.handle('repos:basePath', () => BASE_REPO_PATH)

ipcMain.handle('repos:delete', async (_e, repoPath: string) => {
  if (!isRepositoryPath(repoPath)) {
    throw new Error('Ruta de repositorio fuera del directorio permitido')
  }
  if (!existsSync(repoPath)) throw new Error('El repositorio no existe')

  try {
    await rm(repoPath, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250
    })
  } catch (error) {
    throw buildLocalRepoDeleteError(repoPath, error)
  }
})

// ─── IPC: SVN List (remote) ───────────────────────────────────────────────────
ipcMain.handle('svn:list', async (_e, url: string) => {
  return listRemoteService(url)
})

// ─── IPC: SVN Search Remote ──────────────────────────────────────────────────
ipcMain.handle('svn:searchRemote', async (event, url: string, query: string, deepSearch: boolean) => {
  const response = await searchRemoteService(url, query, deepSearch, {
    onProgress: (progress) => event.sender.send('svn:searchProgress', progress),
    onResult: (result) => event.sender.send('svn:searchResult', result),
    maxResults: 500
  })
  event.sender.send('svn:searchDone', { searched: response.searched, total: response.total })
  return { ok: true }
})

// ─── IPC: SVN Remote actions ────────────────────────────────────────────────
ipcMain.handle('svn:remoteLog', async (_e, url: string, limit = 50) => {
  return remoteLogService(url, limit)
})

ipcMain.handle('svn:remoteMkdir', async (_e, parentUrl: string, name: string, message?: string) => {
  const targetUrl = buildRemoteUrl(parentUrl, name)
  const msg = (message || '').trim() || `Crear carpeta ${name.trim()}`
  const { stdout } = await runSvn(
    ['mkdir', targetUrl, '-m', msg],
    { timeoutMs: 30000 }
  )
  return { success: true, url: targetUrl, output: stdout }
})

ipcMain.handle('svn:remoteCreateFile', async (_e, parentUrl: string, name: string, content = '', message?: string) => {
  const targetUrl = buildRemoteUrl(parentUrl, name)
  const msg = (message || '').trim() || `Crear archivo ${name.trim()}`

  const tempDir = mkdtempSync(join(tmpdir(), 'artisvn-'))
  const tempFile = join(tempDir, name.trim())
  writeFileSync(tempFile, content, 'utf-8')

  try {
    const { stdout } = await runSvn(
      ['import', tempFile, targetUrl, '-m', msg],
      { timeoutMs: 30000 }
    )
    return { success: true, url: targetUrl, output: stdout }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

// ─── IPC: SVN Checkout ───────────────────────────────────────────────────────
ipcMain.handle('svn:checkout', async (event, url: string, targetName: string) => {
  const targetWindow = getEventWindow(event)
  return checkoutRemoteToLocalRepo(url, sanitizeLocalRepoName(targetName), {
    onData: (chunk) => sendToWindow(targetWindow, 'svn:checkout-progress', chunk),
    onErrorData: (chunk) => sendToWindow(targetWindow, 'svn:checkout-progress', chunk)
  })
})

// ─── IPC: SVN Export ─────────────────────────────────────────────────────────
ipcMain.handle('svn:export', async (event, url: string, targetPath: string) => {
  const targetWindow = getEventWindow(event)
  if (existsSync(targetPath)) {
    throw new Error(`Ya existe una carpeta en "${targetPath}"`)
  }
  try {
    await runSvn(
      ['export', url, targetPath],
      {
        timeoutMs: 10 * 60 * 1000,
        onData: (chunk) => sendToWindow(targetWindow, 'svn:export-progress', chunk),
        onErrorData: (chunk) => sendToWindow(targetWindow, 'svn:export-progress', chunk)
      }
    )
    return { success: true, path: targetPath }
  } catch (err: any) {
    const msg = String(err?.message || '').trim()
    throw new Error(msg || 'Error al exportar el repositorio')
  }
})

// ─── IPC: Download single remote file ────────────────────────────────────────
ipcMain.handle('svn:downloadFile', async (_e, url: string, defaultName: string) => {
  const result = await dialog.showSaveDialog({
    title: 'Guardar archivo',
    defaultPath: defaultName,
    buttonLabel: 'Guardar'
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const targetPath = result.filePath
  try {
    await runSvn(['export', '--force', url, targetPath], { timeoutMs: 5 * 60 * 1000 })
    return { success: true, path: targetPath }
  } catch (err: any) {
    const msg = String(err?.message || '').trim()
    throw new Error(msg || 'Error al descargar el archivo')
  }
})

// ─── IPC: Pick export folder ──────────────────────────────────────────────────
ipcMain.handle('dialog:pickExportFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Seleccionar carpeta de destino',
    buttonLabel: 'Seleccionar'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// ─── IPC: SVN Update ─────────────────────────────────────────────────────────
ipcMain.handle('svn:update', async (event, repoPath: string) => {
  const targetWindow = getEventWindow(event)
  return updateLocalRepo(repoPath, {
    onData: (chunk) => sendToWindow(targetWindow, 'svn:update-progress', chunk),
    onErrorData: (chunk) => sendToWindow(targetWindow, 'svn:update-progress', chunk)
  })
})

ipcMain.handle('svn:cleanup', async (_e, repoPath: string) => {
  try {
    const { stdout, stderr } = await runSvn(['cleanup', '.'], {
      cwd: repoPath,
      skipAuth: true,
      timeoutMs: 5 * 60 * 1000
    })
    return { success: true, output: stdout || stderr }
  } catch (err: any) {
    const msg = String(err?.message || '').trim()
    throw new Error(msg || 'No se pudo limpiar la working copy')
  }
})

// ─── IPC: SVN Status ─────────────────────────────────────────────────────────
ipcMain.handle('svn:status', async (_e, repoPath: string) => {
  return localStatusService(repoPath)
})

// ─── IPC: Local file content (for unversioned preview) ──────────────────────
ipcMain.handle('svn:fileContent', async (_e, repoPath: string, filePath: string) => {
  return localFileContentService(repoPath, filePath).text
})

ipcMain.handle('svn:getLocalPreviewFile', async (_e, repoPath: string, filePath: string) => {
  const { targetAbs } = resolveRepoRelativeTarget(repoPath, filePath)

  if (!existsSync(targetAbs)) {
    throw new Error('El archivo no existe localmente')
  }
  if (!statSync(targetAbs).isFile()) {
    throw new Error('Solo se pueden previsualizar archivos')
  }

  return buildPreviewFileResponse(targetAbs)
})

ipcMain.handle('svn:getRemotePreviewFile', async (_e, url: string, defaultName?: string) => {
  return exportRemotePreviewFile(url, defaultName)
})

ipcMain.handle('svn:getConflictContent', async (_e, repoPath: string, filePath: string) => {
  const { targetAbs } = resolveRepoRelativeTarget(repoPath, filePath)
  const dirPath = dirname(targetAbs)
  const fileName = basename(targetAbs)
  const minePath = join(dirPath, `${fileName}.mine`)
  const revisionPattern = new RegExp(`^${escapeRegExp(fileName)}\\.r(\\d+)$`)

  const revisionFiles = readdirSync(dirPath)
    .map((entry) => {
      const match = entry.match(revisionPattern)
      if (!match) return null
      return {
        path: join(dirPath, entry),
        revision: Number.parseInt(match[1], 10) || 0
      }
    })
    .filter((x): x is { path: string; revision: number } => x !== null)
    .sort((a, b) => a.revision - b.revision)

  const basePath = revisionFiles[0]?.path || ''
  const theirsPath = revisionFiles[revisionFiles.length - 1]?.path || ''
  const mine = readUtf8IfExists(minePath) || readUtf8IfExists(targetAbs)
  const base = readUtf8IfExists(basePath)
  const theirs = readUtf8IfExists(theirsPath)

  if (!mine && !base && !theirs) {
    throw new Error('No se encontraron archivos auxiliares de conflicto para ese archivo')
  }

  return { mine, base, theirs }
})

// ─── IPC: SVN Diff ───────────────────────────────────────────────────────────
ipcMain.handle('svn:diff', async (_e, repoPath: string, filePath: string) => {
  return (await localDiffService(repoPath, filePath)).text
})

ipcMain.handle('svn:add', async (_e, repoPath: string, filePath: string, scope: 'item' | 'branch' = 'item') => {
  const safeScope = scope === 'branch' ? 'branch' : 'item'
  const { targetAbs, relativePath } = resolveRepoRelativeTarget(repoPath, filePath)
  if (!existsSync(targetAbs)) {
    throw new Error('El archivo o carpeta ya no existe')
  }

  const normalizedTarget = normalizeRelativePath(relativePath)
  const targetToAdd = safeScope === 'branch'
    ? (await resolveUnversionedBranchTarget(repoPath, normalizedTarget)).branchRelPath
    : normalizedTarget

  await runSvn(['add', '--force', '--parents', toRepoRelativeArg(targetToAdd)], {
    cwd: repoPath,
    timeoutMs: 60_000
  })

  return {
    success: true,
    scope: safeScope,
    target: targetToAdd
  }
})

ipcMain.handle('svn:ignore', async (_e, repoPath: string, filePath: string, scope: 'item' | 'branch' = 'item') => {
  const safeScope = scope === 'branch' ? 'branch' : 'item'
  const { targetAbs, relativePath } = resolveRepoRelativeTarget(repoPath, filePath)
  if (!existsSync(targetAbs)) {
    throw new Error('El archivo o carpeta ya no existe')
  }

  const normalizedTarget = normalizeRelativePath(relativePath)
  if (!normalizedTarget) {
    throw new Error('No se puede ignorar la raíz del repositorio')
  }

  let propertyDirRelPath = ''
  let ignorePattern = ''

  if (safeScope === 'branch') {
    const branchTarget = await resolveUnversionedBranchTarget(repoPath, normalizedTarget)
    propertyDirRelPath = branchTarget.versionedAncestorRelPath
    ignorePattern = branchTarget.branchName
  } else {
    const directParentRelPath = getParentRelativePath(normalizedTarget)
    const versionedParentRelPath = await findNearestVersionedDirectory(repoPath, directParentRelPath)

    if (normalizeRelativePath(versionedParentRelPath) !== normalizeRelativePath(directParentRelPath)) {
      throw new Error('Para ignorar solo este elemento, la carpeta padre debe estar versionada. Usa la opción de ignorar la rama completa.')
    }

    propertyDirRelPath = versionedParentRelPath
    ignorePattern = basename(normalizedTarget)
  }

  const result = await appendIgnorePattern(repoPath, propertyDirRelPath, ignorePattern)

  return {
    success: true,
    scope: safeScope,
    ignoredName: ignorePattern,
    propertyTarget: result.propertyTarget,
    alreadyPresent: result.alreadyPresent
  }
})

ipcMain.handle('svn:blame', async (_e, repoPath: string, filePath: string) => {
  return localBlameService(repoPath, filePath)
})

// ─── IPC: SVN Diff at specific revision ──────────────────────────────────────
ipcMain.handle('svn:revisionFileDiff', async (_e, repoPath: string, revision: number, svnPath: string) => {
  return (await localRevisionFileDiffService(repoPath, revision, svnPath)).text
})

ipcMain.handle('svn:restorePathAtRevision', async (
  _e,
  repoPath: string,
  revision: number,
  svnPath: string,
  action: 'A' | 'M' | 'D' | 'R' = 'M'
) => {
  const safeAction = String(action || 'M').trim().toUpperCase()
  if (!['A', 'M', 'D', 'R'].includes(safeAction)) {
    throw new Error('Acción de historial no soportada')
  }

  const targetRevision = safeAction === 'D' ? Number(revision) - 1 : Number(revision)
  if (!Number.isFinite(targetRevision) || targetRevision < 1) {
    throw new Error('No existe una revisión anterior disponible para restaurar este elemento')
  }

  const { stdout: infoXml } = await runSvn(['info', '--xml'], { cwd: repoPath })
  const parsedInfo = await xml2js.parseStringPromise(infoXml, { explicitArray: false })
  const entry = parsedInfo?.info?.entry
  const rootUrl: string = entry?.repository?.root || ''
  const wcUrl: string = entry?.url || ''
  if (!rootUrl || !wcUrl) {
    throw new Error('No se pudo obtener la ubicación SVN de la copia local')
  }

  const workingCopyScope = getWorkingCopyScopePath({ url: wcUrl, rootUrl })
  const repoScopedPath = normalizeSvnRepoPath(svnPath)
  const relativeTargetPath = mapRepoPathToWorkingCopyRelativePath(repoScopedPath, workingCopyScope)
  if (relativeTargetPath === null) {
    throw new Error('Ese elemento está fuera del alcance de esta copia local')
  }
  if (!relativeTargetPath) {
    throw new Error('No se puede restaurar la raíz completa de la copia local desde esta vista')
  }

  const restoreUrl = `${rootUrl}${repoScopedPath}@${targetRevision}`
  const { stdout: remoteInfoXml } = await runSvn(['info', '--xml', restoreUrl], { timeoutMs: 15000 })
  const parsedRemoteInfo = await xml2js.parseStringPromise(remoteInfoXml, { explicitArray: false })
  const remoteEntry = parsedRemoteInfo?.info?.entry
  const remoteKind = String(remoteEntry?.$?.kind || '').trim() === 'dir' ? 'dir' : 'file'

  const { targetAbs } = resolveRepoRelativeTarget(repoPath, relativeTargetPath)
  const parentDir = dirname(targetAbs)
  mkdirSync(parentDir, { recursive: true })

  if (existsSync(targetAbs)) {
    const stat = statSync(targetAbs)
    if (remoteKind === 'dir' && !stat.isDirectory()) {
      throw new Error('La ruta local actual es un archivo y no puede restaurarse como carpeta')
    }
    if (remoteKind === 'file' && stat.isDirectory()) {
      throw new Error('La ruta local actual es una carpeta y no puede restaurarse como archivo')
    }
  }

  await runSvn(['export', '--force', restoreUrl, targetAbs], {
    cwd: repoPath,
    timeoutMs: 5 * 60 * 1000
  })

  return {
    success: true,
    path: relativeTargetPath,
    kind: remoteKind,
    restoredRevision: targetRevision
  }
})

// ─── IPC: SVN Commit ─────────────────────────────────────────────────────────
ipcMain.handle('svn:commit', async (_e, repoPath: string, files: string[], message: string) => {
  // Normalize the working-copy state before committing selected paths.
  const statusResult = await runSvn(['status', '--xml'], { cwd: repoPath })
  const parsed = await parseXml(statusResult.stdout)
  const target = parsed.status?.target

  const normalizeStatusPath = (entryPath: string): string => {
    const raw = String(entryPath || '.').replace(/\\/g, '/').trim()
    if (!raw || raw === '.') return '.'
    if (isAbsolute(raw)) {
      const rel = relative(resolve(repoPath), raw).replace(/\\/g, '/')
      return toRepoRelativeArg(rel)
    }
    return toRepoRelativeArg(raw)
  }

  const normalizePathKey = (inputPath: string): string => {
    const normalized = String(inputPath || '').replace(/\\/g, '/').trim()
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  const selected = Array.from(new Set(files.map((f) => String(f || '').trim()).filter(Boolean)))
  const selectedKeyToOriginal = new Map<string, string>()
  selected.forEach((f) => selectedKeyToOriginal.set(normalizePathKey(f), f))

  const statusByPathKey = new Map<string, string>()
  if (target?.entry) {
    const entries = Array.isArray(target.entry) ? target.entry : [target.entry]
    for (const e of entries) {
      const item = String(e['wc-status']?.$?.item || '')
      const p = normalizeStatusPath(String(e.$?.path || ''))
      if (!p) continue
      const key = normalizePathKey(p)
      statusByPathKey.set(key, item)
    }

    const missingToDelete = selected.filter((selectedPath) => {
      const key = normalizePathKey(selectedPath)
      return statusByPathKey.get(key) === 'missing'
    })

    if (missingToDelete.length > 0) {
      await runSvn(['delete', '--force', ...missingToDelete], { cwd: repoPath })
    }

    const toAddSet = new Set<string>()

    // 1) Explicitly unversioned entries reported by SVN status
    for (const [pathKey, item] of statusByPathKey.entries()) {
      if (item !== 'unversioned') continue
      const selectedOriginal = selectedKeyToOriginal.get(pathKey)
      if (selectedOriginal) toAddSet.add(selectedOriginal)
    }

    // 2) Expanded entries that may not appear in SVN XML (e.g. files inside new dirs)
    for (const selectedPath of selected) {
      const key = normalizePathKey(selectedPath)
      const known = statusByPathKey.get(key)
      if (known) continue

      const abs = resolve(repoPath, selectedPath)
      if (existsSync(abs)) {
        toAddSet.add(selectedPath)
      }
    }

    const toAdd = Array.from(toAddSet)

    if (toAdd.length > 0) {
      await runSvn(['add', '--force', '--parents', ...toAdd], { cwd: repoPath })
    }

    // Re-read status after add so we can include any required added parent dirs
    const statusAfterAdd = await runSvn(['status', '--xml'], { cwd: repoPath })
    const parsedAfterAdd = await parseXml(statusAfterAdd.stdout)
    const targetAfterAdd = parsedAfterAdd.status?.target
    const statusAfterByPathKey = new Map<string, string>()
    const pathAfterKeyToPath = new Map<string, string>()

    if (targetAfterAdd?.entry) {
      const entriesAfter = Array.isArray(targetAfterAdd.entry) ? targetAfterAdd.entry : [targetAfterAdd.entry]
      for (const e of entriesAfter) {
        const item = String(e['wc-status']?.$?.item || '')
        const p = normalizeStatusPath(String(e.$?.path || ''))
        if (!p) continue
        const key = normalizePathKey(p)
        statusAfterByPathKey.set(key, item)
        pathAfterKeyToPath.set(key, p)
      }
    }

    const commitSet = new Set(selected)
    const isPathAncestor = (ancestor: string, descendant: string) => {
      const a = normalizePathKey(ancestor).replace(/\/+$/g, '')
      const d = normalizePathKey(descendant)
      return d === a || d.startsWith(`${a}/`)
    }

    // If a selected path is under a newly added parent dir, include that parent in commit targets.
    for (const [key, item] of statusAfterByPathKey.entries()) {
      if (item !== 'added') continue
      const parentPath = pathAfterKeyToPath.get(key)
      if (!parentPath) continue

      for (const selectedPath of selected) {
        if (isPathAncestor(parentPath, selectedPath) && normalizePathKey(parentPath) !== normalizePathKey(selectedPath)) {
          commitSet.add(parentPath)
          break
        }
      }
    }

    const commitTargets = Array.from(commitSet)

    const { stdout } = await runSvn(
      ['commit', ...commitTargets, '-m', message],
      { cwd: repoPath }
    )
    return { success: true, output: stdout }
  }

  const { stdout } = await runSvn(
    ['commit', ...selected, '-m', message],
    { cwd: repoPath }
  )
  return { success: true, output: stdout }
})

// ─── IPC: SVN Revert ─────────────────────────────────────────────────────────
ipcMain.handle('svn:revert', async (_e, repoPath: string, files: string[]) => {
  const { stdout } = await runSvn(['revert', '--recursive', ...files], { cwd: repoPath })
  return { success: true, output: stdout }
})

ipcMain.handle('svn:resolve', async (_e, repoPath: string, filePath: string, accept: string) => {
  const safeAccept = String(accept || '').trim()
  if (safeAccept !== 'mine-full' && safeAccept !== 'theirs-full' && safeAccept !== 'working') {
    throw new Error('Resolución no soportada')
  }

  const { relativePath } = resolveRepoRelativeTarget(repoPath, filePath)
  const { stdout } = await runSvn(['resolve', '--accept', safeAccept, relativePath], {
    cwd: repoPath
  })
  return { success: true, output: stdout }
})

// ─── IPC: SVN Log ────────────────────────────────────────────────────────────
ipcMain.handle('svn:log', async (_e, repoPath: string, limit = 50, fromRevision?: number) => {
  return localLogService(repoPath, limit, fromRevision)
})

// ─── IPC: SVN Cat (remote file content) ──────────────────────────────────────
ipcMain.handle('svn:cat', async (_e, url: string) => {
  return (await remoteFileContentService(url)).text
})

// ─── IPC: SVN Repo Root URL ──────────────────────────────────────────────────
ipcMain.handle('svn:getRepoRoot', async (_e, url: string) => {
  return remoteRepoRootService(url)
})

// ─── IPC: SVN Remote Diff at specific revision ───────────────────────────────
ipcMain.handle('svn:remoteRevisionDiff', async (_e, baseUrl: string, svnPath: string, revision: number) => {
  return (await remoteRevisionDiffService(baseUrl, svnPath, revision)).text
})

// ─── IPC: SVN Info ───────────────────────────────────────────────────────────
ipcMain.handle('svn:info', async (_e, path: string) => {
  return svnInfoService(path)
})

// ─── IPC: Dialog ─────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async (_e, repoPath: string, filePath: string) => {
  shell.openPath(join(repoPath, filePath))
})

ipcMain.handle('dialog:openFolder', async (_e, path: string) => {
  shell.openPath(path)
})

ipcMain.handle('dialog:listEditors', async () => {
  return detectEditors().map(({ id, label }) => ({ id, label }))
})

ipcMain.handle('dialog:openInEditor', async (_e, editorId: string, repoPath: string) => {
  const safeEditorId = (editorId || '').trim()
  const safeRepoPath = (repoPath || '').trim()
  if (!isRepositoryPath(safeRepoPath)) {
    throw new Error('Ruta de repositorio fuera del directorio permitido')
  }
  if (safeEditorId !== 'vscode' && safeEditorId !== 'vscode-insiders') {
    throw new Error('Editor no soportado')
  }

  openRepoInEditor(safeEditorId, safeRepoPath)
  return true
})

// ─── IPC: SVN test connection ────────────────────────────────────────────────
ipcMain.handle('svn:ping', async (_e, url: string) => {
  try {
    await runSvn(['info', '--xml', url], { timeoutMs: 15000 })
    return { ok: true }
  } catch (err: any) {
    const msg = err.message || ''
    if (msg.includes('Authentication') || msg.includes('authorization') || msg.includes('E170001')) {
      return { ok: false, authError: true, message: msg }
    }
    return { ok: false, authError: false, message: msg }
  }
})

// Ping usando credenciales inline — sin persistir en el store
ipcMain.handle('svn:pingWithCreds', async (_e, creds: { url: string; username: string; password: string }) => {
  const inlineAuthArgs = buildInlineAuthArgs(creds.username, creds.password)
  try {
    await runSvn(['info', '--xml', creds.url, ...inlineAuthArgs], { skipAuth: true, timeoutMs: 15000 })
    return { ok: true }
  } catch (err: any) {
    const msg = err.message || ''
    if (msg.includes('Authentication') || msg.includes('authorization') || msg.includes('E170001')) {
      return { ok: false, authError: true, message: msg }
    }
    return { ok: false, authError: false, message: msg }
  }
})

// ─── IPC: Get SVN binary info ────────────────────────────────────────────────
ipcMain.handle('svn:version', async () => {
  try {
    const { stdout } = await runSvn(['--version', '--quiet'], { skipAuth: true })
    return { version: stdout.trim(), bin: getSvnBin() }
  } catch {
    return { version: null, bin: getSvnBin() }
  }
})

// ─── IPC: Install SVN via Homebrew (fallback) ────────────────────────────────
ipcMain.handle('svn:install', async (event) => {
  const targetWindow = getEventWindow(event)
  if (process.platform === 'win32') {
    throw new Error('En Windows, ArtiSVN incluye SVN integrado. Si hay problemas, descarga TortoiseSVN desde https://tortoisesvn.net')
  }

  return new Promise((resolve, reject) => {
    const brewBin = existsSync('/opt/homebrew/bin/brew')
      ? '/opt/homebrew/bin/brew'
      : '/usr/local/bin/brew'

    if (!existsSync(brewBin)) {
      reject(new Error('Homebrew no está instalado. Visita https://brew.sh'))
      return
    }

    const extraPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    const proc = spawn(brewBin, ['install', 'subversion'], {
      env: { ...process.env, PATH: extraPath }
    })

    proc.stdout.on('data', (d: Buffer) => {
      sendToWindow(targetWindow, 'svn:install-progress', d.toString())
    })
    proc.stderr.on('data', (d: Buffer) => {
      sendToWindow(targetWindow, 'svn:install-progress', d.toString())
    })
    proc.on('close', (code) => {
      if (code === 0) {
        const refreshed = setSvnBin('svn')
        resolve({ success: true, bin: refreshed.bin })
      } else {
        reject(new Error('Error al instalar SVN via Homebrew'))
      }
    })
    proc.on('error', reject)
  })
})
