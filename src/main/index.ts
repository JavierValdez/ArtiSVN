import { app, BrowserWindow, Menu, session, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { setupAppUpdater } from './updater'
import { dirname, join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { BASE_REPO_PATH } from './services/local-paths'
import { startAgentBrokerIfEnabled, stopAgentBroker } from './agent/integration'
import { runMcpServerMode } from './agent/mcp-server'
import { MCP_ENV, resolveMcpEnv } from './agent/identity'
import { inspectAppMigration } from './services/app-migration'
import { isTrustedRendererUrl } from './ipc/guard'
import { registerRepoIpc } from './ipc/repo-ipc'
import { cleanupPreviewTempDirs, registerRemoteIpc } from './ipc/remote-ipc'
import { registerCredentialsIpc } from './ipc/creds-ipc'
import { registerAppIpc } from './ipc/app-ipc'

const isDev = process.env.NODE_ENV === 'development'
const mcpStdioValue = resolveMcpEnv(process.env, MCP_ENV.stdio, MCP_ENV.legacyStdio)
const mcpTokenValue = resolveMcpEnv(process.env, MCP_ENV.token, MCP_ENV.legacyToken)
const isMcpStdioMode = process.argv.includes('--mcp-stdio')
  || mcpStdioValue === '1'
  || Boolean(mcpTokenValue)

// Set app name before ready so it shows correctly in the dock and menu bar.
app.name = 'ArtiSVN'

// Development/smoke-test only: isolate configuration from the personal install.
// Ignored in packaged builds.
const devAppDataDir = !app.isPackaged ? process.env.ARTISVN_DEV_APPDATA_DIR : undefined
if (devAppDataDir) {
  app.setPath('appData', devAppDataDir)
  app.setPath('userData', join(devAppDataDir, 'ArtiSVN'))
}

// Renderer hardening that applies to every web contents.
app.enableSandbox()

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

if (!existsSync(BASE_REPO_PATH)) {
  mkdirSync(BASE_REPO_PATH, { recursive: true })
}

// ─── External links / navigation ───────────────────────────────────────────

/** Only https links are opened externally (no file:, smb:, custom schemes). */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

function hardenWebContents(window: BrowserWindow): void {
  const contents = window.webContents

  contents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const blockNavigation = (event: Electron.Event, url: string) => {
    if (isTrustedRendererUrl(url)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  }
  contents.on('will-navigate', blockNavigation)
  contents.on('will-redirect', blockNavigation)
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

function configureSessionSecurity(): void {
  const allowedPermissions = new Set(['clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowedPermissions.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission))
}

// ─── Main Window ─────────────────────────────────────────────────────────────

function createWindow(sourceWindow?: BrowserWindow | null): BrowserWindow {
  const preloadCandidates = [
    join(__dirname, '../preload/index.cjs'),
    join(__dirname, '../preload/index.js'),
    join(__dirname, '../preload/index.mjs')
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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      webviewTag: false
    }
  })

  hardenWebContents(window)

  const shouldMaximize = Boolean(sourceWindow && !sourceWindow.isDestroyed() && sourceWindow.isMaximized())
  if (sourceWindow && !sourceWindow.isDestroyed() && !shouldMaximize) {
    const [x, y] = sourceWindow.getPosition()
    const [width, height] = sourceWindow.getSize()
    window.setBounds({ x: x + 28, y: y + 28, width, height })
  }

  window.on('ready-to-show', () => {
    if (shouldMaximize) window.maximize()
    window.show()
    setupAppUpdater(window)
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function openNewWindow(sourceWindow?: BrowserWindow | null): BrowserWindow {
  const referenceWindow = sourceWindow && !sourceWindow.isDestroyed()
    ? sourceWindow
    : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  return createWindow(referenceWindow)
}

function setupDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  app.dock.setMenu(Menu.buildFromTemplate([
    { label: 'Nueva ventana', click: () => { openNewWindow() } }
  ]))
}

function setupApplicationMenu(): void {
  const fileSubmenu: MenuItemConstructorOptions[] = [
    { label: 'Nueva ventana', accelerator: 'CmdOrCtrl+N', click: () => { openNewWindow() } },
    { type: 'separator' },
    process.platform === 'darwin'
      ? { role: 'close', label: 'Cerrar ventana' }
      : { role: 'quit', label: 'Salir' }
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'Archivo', submenu: fileSubmenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── IPC registration (handlers live in src/main/ipc/*) ─────────────────────

if (!isMcpStdioMode) {
  registerCredentialsIpc()
  registerRepoIpc()
  registerRemoteIpc()
  registerAppIpc({
    getMigrationOptions: getAppMigrationOptions,
    onMigrationResolved: startAgentBrokerWhenMigrationResolved,
    openNewWindow: (source) => { openNewWindow(source) }
  })
}

app.whenReady().then(() => {
  if (isMcpStdioMode) return
  if (process.platform === 'win32') app.setAppUserModelId('com.artisvn.app')

  // Set dock icon in dev mode (in production the .icns in the bundle is used automatically)
  if (isDev && process.platform === 'darwin' && app.dock) {
    const iconPath = join(app.getAppPath(), 'ico.png')
    if (existsSync(iconPath)) app.dock.setIcon(iconPath)
  }

  configureSessionSecurity()
  setupApplicationMenu()
  setupDockMenu()
  void startAgentBrokerWhenMigrationResolved().catch((error) => {
    console.error('No se pudo iniciar el broker MCP:', error instanceof Error ? error.message : error)
  })
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
