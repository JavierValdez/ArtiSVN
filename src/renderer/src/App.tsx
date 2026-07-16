import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react'
import { ActiveTab, AgentActivityEntry, AgentClientConfig, AgentIntegrationState, BlameLine, ConflictAccept, ConflictContent, Credentials, EditorId, EditorOption, FileChange, LocalRepo, MigrationAction, MigrationInspection, MigrationResult, RemoteServer } from './types/svn'
import Sidebar from './components/Sidebar'
import ChangesView from './components/ChangesView'
import ExplorerView from './components/ExplorerView'
import HistoryView from './components/HistoryView'
import AuthDialog from './components/AuthDialog'
import ProfileDialog from './components/ProfileDialog'
import AgentIntegrationDialog from './components/AgentIntegrationDialog'
import VerticalResizeHandle from './components/VerticalResizeHandle'
import { useResizablePanel } from './hooks/useResizablePanel'

export interface AppUpdateState {
  stage: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  currentVersion: string
  autoUpdatesEnabled: boolean
  mode: 'manual' | 'unsupported'
  latestVersion: string | null
  downloadedVersion: string | null
  progressPercent: number | null
  lastCheckedAt: string | null
  releaseName: string | null
  releaseDate: string | null
  releaseNotes: string | null
  downloadUrl: string | null
  downloadFileName: string | null
  downloadedInstallerPath: string | null
  error: string | null
}

declare global {
  interface Window {
    svn: {
      getCredentials: () => Promise<Credentials | null>
      setCredentials: (c: { username: string; password: string; serverUrl: string }) => Promise<boolean>
      updateCredentials: (c: { username: string; password: string; serverUrl: string }) => Promise<boolean>
      clearCredentials: () => Promise<boolean>
      getServerUrl: () => Promise<string>
      setServerUrl: (serverUrl: string) => Promise<boolean>
      listRemotes: () => Promise<RemoteServer[]>
      saveRemote: (remote: { name: string; url: string }) => Promise<RemoteServer>
      selectRemote: (remoteId: string) => Promise<RemoteServer>
      deleteRemote: (remoteId: string) => Promise<boolean>
      renameRemote: (remoteId: string, name: string, url?: string) => Promise<RemoteServer>
      listLocalRepos: () => Promise<LocalRepo[]>
      getBasePath: () => Promise<string>
      deleteRepo: (repoPath: string) => Promise<void>
      listRemote: (url: string) => Promise<any[]>
      searchRemote: (url: string, query: string, deepSearch: boolean) => Promise<{ ok: boolean }>
      onSearchResult: (cb: (result: { path: string; name: string; kind: 'dir' | 'file' | 'revision'; matchType: 'name' | 'content' | 'comment'; entryUrl: string; revision?: number; revisionMessage?: string }) => void) => () => void
      onSearchProgress: (cb: (data: { searched: number; total: number; listingStats?: { dirs: number; entries: number } }) => void) => () => void
      onSearchDone: (cb: (data: { searched: number; total: number }) => void) => () => void
      remoteLog: (url: string, limit?: number) => Promise<any[]>
      remoteFileContent: (url: string) => Promise<string>
      getRepoRoot: (url: string) => Promise<string | null>
      remoteRevisionDiff: (baseUrl: string, svnPath: string, revision: number) => Promise<string>
      remoteMkdir: (parentUrl: string, name: string, message?: string) => Promise<any>
      remoteCreateFile: (parentUrl: string, name: string, content?: string, message?: string) => Promise<any>
      downloadFile: (url: string, defaultName: string) => Promise<{ canceled?: boolean; success?: boolean; path?: string }>
      ping: (url: string) => Promise<{ ok: boolean; authError?: boolean; message?: string }>
      pingWithCreds: (creds: { url: string; username: string; password: string }) => Promise<{ ok: boolean; authError?: boolean; message?: string }>
      getVersion: () => Promise<{ version: string | null; bin: string }>
      getBinPath: () => Promise<{ bin: string; configured: string | null; version: string | null }>
      setBinPath: (binPath: string) => Promise<{ bin: string; version: string | null }>
      checkout: (url: string, targetName: string) => Promise<any>
      update: (repoPath: string) => Promise<any>
      cleanup: (repoPath: string) => Promise<any>
      status: (repoPath: string) => Promise<FileChange[]>
      diff: (repoPath: string, filePath: string) => Promise<string>
      fileContent: (repoPath: string, filePath: string) => Promise<string>
      getLocalPreviewFile: (repoPath: string, filePath: string) => Promise<{ name: string; base64: string }>
      getRemotePreviewFile: (url: string, defaultName: string) => Promise<{ name: string; base64: string }>
      add: (repoPath: string, filePath: string, scope?: 'item' | 'branch') => Promise<{ success: boolean; scope: 'item' | 'branch'; target: string }>
      ignore: (repoPath: string, filePath: string, scope?: 'item' | 'branch') => Promise<{ success: boolean; scope: 'item' | 'branch'; ignoredName: string; propertyTarget: string; alreadyPresent: boolean }>
      getConflictContent: (repoPath: string, filePath: string) => Promise<ConflictContent>
      revisionFileDiff: (repoPath: string, revision: number, svnPath: string) => Promise<string>
      restorePathAtRevision: (repoPath: string, revision: number, svnPath: string, action: 'A' | 'M' | 'D' | 'R') => Promise<{ success: boolean; path: string; kind: 'file' | 'dir'; restoredRevision: number }>
      blame: (repoPath: string, filePath: string) => Promise<BlameLine[]>
      commit: (repoPath: string, files: string[], message: string) => Promise<any>
      revert: (repoPath: string, files: string[]) => Promise<any>
      resolve: (repoPath: string, filePath: string, accept: ConflictAccept) => Promise<any>
      log: (repoPath: string, limit?: number, fromRevision?: number) => Promise<any[]>
      info: (path: string) => Promise<any>
      openFile: (repoPath: string, filePath: string) => Promise<void>
      openFolder: (path: string) => Promise<void>
      listEditors: () => Promise<EditorOption[]>
      openInEditor: (editorId: EditorId, repoPath: string) => Promise<void>
      newWindow: () => Promise<boolean>
      installSvn: () => Promise<{ success: boolean; bin: string }>
      svnExport: (url: string, targetPath: string) => Promise<{ success: boolean; path: string }>
      pickExportFolder: () => Promise<string | null>
      onCheckoutProgress: (cb: (msg: string) => void) => () => void
      onUpdateProgress: (cb: (msg: string) => void) => () => void
      onInstallProgress: (cb: (msg: string) => void) => () => void
      onExportProgress: (cb: (msg: string) => void) => () => void
      getUpdateState: () => Promise<AppUpdateState>
      checkForUpdates: () => Promise<AppUpdateState>
      downloadUpdate: () => Promise<AppUpdateState>
      onAppUpdateState: (cb: (state: AppUpdateState) => void) => () => void
    }
    appMigration: {
      inspect: () => Promise<MigrationInspection>
      runAction: (action: MigrationAction) => Promise<MigrationResult>
    }
    appUpdate: {
      getState: () => Promise<AppUpdateState>
      check: () => Promise<AppUpdateState>
      download: () => Promise<AppUpdateState>
      onState: (cb: (state: AppUpdateState) => void) => () => void
    }
    agentIntegration: {
      getState: () => Promise<AgentIntegrationState>
      setEnabled: (enabled: boolean) => Promise<AgentIntegrationState>
      getClientConfig: () => Promise<AgentClientConfig>
      regenerateToken: () => Promise<AgentIntegrationState>
      getActivity: () => Promise<AgentActivityEntry[]>
      clearActivity: () => Promise<AgentActivityEntry[]>
      onState: (cb: (state: AgentIntegrationState) => void) => () => void
      onActivity: (cb: (activity: AgentActivityEntry[]) => void) => () => void
    }
  }
}

interface Toast { id: number; message: string; type: 'success' | 'error' | 'info' }
const DEFAULT_SERVER_URL = ''

function getAppUpdateBannerText(state: AppUpdateState): string {
  if (state.stage === 'downloading') {
    return state.progressPercent !== null
      ? `Descargando actualización ${state.progressPercent}%`
      : 'Descargando actualización...'
  }

  if (state.stage === 'downloaded') {
    return `Instalador listo en Descargas: ${state.downloadFileName || `ArtiSVN ${state.downloadedVersion || state.latestVersion || ''}`}`
  }

  return `Nueva versión ${state.latestVersion} disponible`
}

function getAppUpdateActionLabel(state: AppUpdateState): string {
  if (state.stage === 'downloading') return state.progressPercent !== null ? `${state.progressPercent}%` : 'Descargando'
  if (state.stage === 'downloaded') return 'Mostrar'
  return 'Descargar'
}

function buildChangesSignature(changes: FileChange[]): string {
  return changes
    .map((change) => `${change.status}:${change.kind}:${change.path}`)
    .sort()
    .join('\n')
}

export default function App() {
  const [migrationGateReady, setMigrationGateReady] = useState(false)
  const [migrationInspection, setMigrationInspection] = useState<MigrationInspection | null>(null)
  const [showMigrationDialog, setShowMigrationDialog] = useState(false)
  const [migrationRunning, setMigrationRunning] = useState(false)
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null)
  const [migrationError, setMigrationError] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [showAuthDialog, setShowAuthDialog] = useState(false)
  const [authInitialServerUrl, setAuthInitialServerUrl] = useState(DEFAULT_SERVER_URL)
  const [remoteServers, setRemoteServers] = useState<RemoteServer[]>([])
  const [activeRemoteId, setActiveRemoteId] = useState<string | null>(null)
  const [localRepos, setLocalRepos] = useState<LocalRepo[]>([])
  const [selectedRepo, setSelectedRepo] = useState<LocalRepo | null>(null)
  const [activeTab, setActiveTab] = useState<ActiveTab>('changes')
  const [changes, setChanges] = useState<FileChange[]>([])
  const [loadingChanges, setLoadingChanges] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updateLog, setUpdateLog] = useState('')
  const [showUpdateProgress, setShowUpdateProgress] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [svnMissing, setSvnMissing] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState('')
  const [showAddRemoteDialog, setShowAddRemoteDialog] = useState(false)
  const [addRemoteUrl, setAddRemoteUrl] = useState('')
  const [addRemoteName, setAddRemoteName] = useState('')
  const [repoToDelete, setRepoToDelete] = useState<LocalRepo | null>(null)
  const [remoteToDelete, setRemoteToDelete] = useState<RemoteServer | null>(null)
  const [remoteToRename, setRemoteToRename] = useState<RemoteServer | null>(null)
  const [renameRemoteName, setRenameRemoteName] = useState('')
  const [renameRemoteUrl, setRenameRemoteUrl] = useState('')
  const [availableEditors, setAvailableEditors] = useState<EditorOption[]>([])
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null)
  const [showProfileDialog, setShowProfileDialog] = useState(false)
  const [showAgentIntegrationDialog, setShowAgentIntegrationDialog] = useState(false)
  const [authErrorDetected, setAuthErrorDetected] = useState(false)
  const selectedRepoPathRef = useRef<string | null>(null)
  const changesSignatureRef = useRef('')
  const loadChangesRequestIdRef = useRef(0)
  const {
    containerRef: appBodyRef,
    width: sidebarWidth,
    isResizing: isSidebarResizing,
    resizeHandleProps: sidebarResizeHandleProps
  } = useResizablePanel<HTMLDivElement>({
    storageKey: 'layout.sidebarWidth',
    defaultWidth: 260,
    minWidth: 220,
    maxWidth: 420,
    minRemainingWidth: 520
  })
  const hasIncompleteWorkingCopy = changes.some((change) => change.status === 'I')

  selectedRepoPathRef.current = selectedRepo?.path || null
  changesSignatureRef.current = buildChangesSignature(changes)

  const toast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now()
    setToasts((t) => [...t, { id, message, type }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500)
  }, [])

  // Migration is inspected before normal initialization so legacy data is not
  // read or mutated until the user has made an explicit choice.
  useEffect(() => {
    let active = true
    window.appMigration.inspect()
      .then((inspection) => {
        if (!active) return
        setMigrationInspection(inspection)
        if (inspection.needed) {
          setShowMigrationDialog(true)
        } else {
          setMigrationGateReady(true)
        }
      })
      .catch(() => {
        if (!active) return
        setMigrationError('No se pudo comprobar el estado de migración.')
        setShowMigrationDialog(true)
      })
    return () => { active = false }
  }, [])

  // Normal app initialization starts only after migration is unnecessary or the
  // user has chosen an action. It is allowed to continue behind a result dialog.
  useEffect(() => {
    if (!migrationGateReady) return

    const init = async () => {
      try {
        const serverUrl = await window.svn.getServerUrl()
        setAuthInitialServerUrl(serverUrl || DEFAULT_SERVER_URL)

        const remotes = await window.svn.listRemotes()
        setRemoteServers(remotes)
        setActiveRemoteId(remotes.find((r) => r.active)?.id || null)

        const creds = await window.svn.getCredentials()
        const validCreds = creds?.username ? creds : null
        setCredentials(validCreds)
        if (!validCreds) setShowAuthDialog(true)

        const repos = await window.svn.listLocalRepos()
        setLocalRepos(repos)
        if (repos.length > 0) setSelectedRepo(repos[0])

        try {
          const editors = await window.svn.listEditors()
          setAvailableEditors(Array.isArray(editors) ? editors : [])
        } catch {
          setAvailableEditors([])
        }

        const ver = await window.svn.getVersion()
        if (ver.version === null) setSvnMissing(true)

        try {
          const updateSt = await window.svn.getUpdateState()
          setAppUpdateState(updateSt)
        } catch {
          // updater not available
        }
      } catch (err: any) {
        console.error(err)
        toast('No se pudo inicializar la API de SVN. Abre la app desde Electron.', 'error')
      }
    }
    init()

    const unsubUpdate = window.svn.onAppUpdateState?.((state) => setAppUpdateState(state))
    return () => { unsubUpdate?.() }
  }, [migrationGateReady, toast])

  const loadChanges = async (options: { silent?: boolean } = {}) => {
    const repoPath = selectedRepoPathRef.current
    if (!repoPath) return

    const requestId = ++loadChangesRequestIdRef.current
    if (!options.silent) setLoadingChanges(true)

    try {
      const nextChanges = await window.svn.status(repoPath)
      if (loadChangesRequestIdRef.current !== requestId) return
      if (selectedRepoPathRef.current !== repoPath) return

      const nextSignature = buildChangesSignature(nextChanges)
      if (options.silent && nextSignature === changesSignatureRef.current) return

      setChanges(nextChanges)
    } catch (err: any) {
      console.error(err)
    } finally {
      if (!options.silent && loadChangesRequestIdRef.current === requestId) {
        setLoadingChanges(false)
      }
    }
  }

  // Load changes when repo changes
  useEffect(() => {
    if (!selectedRepo) return
    setChanges([])
    void loadChanges()
  }, [selectedRepo?.path])

  // Poll changes in the background every 15 s while on the changes tab.
  // This avoids resetting the panel with a visible loading state.
  const loadChangesRef = useRef(loadChanges)
  loadChangesRef.current = loadChanges
  useEffect(() => {
    if (!selectedRepo || activeTab !== 'changes') return
    const id = setInterval(() => {
      void loadChangesRef.current({ silent: true })
    }, 15_000)
    return () => clearInterval(id)
  }, [selectedRepo?.path, activeTab])

  const refreshRepos = async () => {
    const repos = await window.svn.listLocalRepos()
    setLocalRepos(repos)
    if (selectedRepo) {
      const updated = repos.find((r) => r.path === selectedRepo.path)
      if (updated) setSelectedRepo(updated)
    }
  }

  const refreshRemotes = async () => {
    const remotes = await window.svn.listRemotes()
    setRemoteServers(remotes)
    setActiveRemoteId(remotes.find((r) => r.active)?.id || null)
  }

  const handleAppUpdateDownload = async () => {
    try {
      const wasDownloaded = appUpdateState?.stage === 'downloaded'
      const nextState = await window.svn.downloadUpdate()
      setAppUpdateState(nextState)
      if (nextState.stage === 'downloaded' && !wasDownloaded) {
        toast('Instalador descargado en Descargas', 'success')
      } else if (nextState.stage === 'error') {
        toast(nextState.error || 'No se pudo descargar la actualización', 'error')
      }
    } catch (err: any) {
      toast(err.message || 'No se pudo descargar la actualización', 'error')
    }
  }

  const handleAppUpdateCheck = async () => {
    try {
      setAppUpdateState(await window.svn.checkForUpdates())
    } catch (err: any) {
      toast(err.message || 'No se pudo buscar actualizaciones', 'error')
    }
  }

  const handleUpdate = async () => {
    if (!selectedRepo) return
    setUpdating(true)
    setUpdateLog('')
    setShowUpdateProgress(true)

    const unsub = window.svn.onUpdateProgress((msg) => {
      setUpdateLog((prev) => prev + msg)
    })

    try {
      await window.svn.update(selectedRepo.path)
      toast('Repositorio actualizado correctamente', 'success')
      await loadChanges({ silent: true })
      await refreshRepos()
    } catch (err: any) {
      toast(err.message || 'Error al actualizar', 'error')
    } finally {
      unsub()
      setUpdating(false)
      setShowUpdateProgress(false)
    }
  }

  const handleRepairWorkingCopy = async () => {
    if (!selectedRepo) return
    if (!confirm('La working copy está incompleta o bloqueada. Ejecuta la reparación solo si no hay otro cliente SVN usando esta carpeta.')) return

    setUpdating(true)
    setUpdateLog('Ejecutando svn cleanup...\n')
    setShowUpdateProgress(true)

    const unsub = window.svn.onUpdateProgress((msg) => {
      setUpdateLog((prev) => prev + msg)
    })

    try {
      await window.svn.cleanup(selectedRepo.path)
      setUpdateLog((prev) => `${prev}Ejecutando svn update...\n`)
      await window.svn.update(selectedRepo.path)
      toast('Working copy reparada correctamente', 'success')
      await loadChanges({ silent: true })
      await refreshRepos()
    } catch (err: any) {
      toast(err.message || 'No se pudo reparar la working copy', 'error')
      await loadChanges({ silent: true })
      await refreshRepos()
    } finally {
      unsub()
      setUpdating(false)
      setShowUpdateProgress(false)
    }
  }

  const handleSelectRepo = (repo: LocalRepo) => {
    setChanges([])
    setLoadingChanges(true)
    setSelectedRepo(repo)
    setActiveTab('changes')
  }

  const handleAuthSave = async (creds: { username: string; password: string; serverUrl: string }) => {
    await window.svn.setCredentials(creds)
    setCredentials(creds as Credentials)
    setAuthInitialServerUrl(creds.serverUrl || DEFAULT_SERVER_URL)
    setShowAuthDialog(false)
    toast('Credenciales guardadas', 'success')
    await refreshRepos()
    await refreshRemotes()
  }

  const handleRequestCredentials = (serverUrl?: string, authError = false) => {
    if (serverUrl?.trim()) setAuthInitialServerUrl(serverUrl.trim())
    setAuthErrorDetected(authError)
    if (authError && credentials) {
      setShowProfileDialog(true)
    } else {
      setShowAuthDialog(true)
    }
  }

  const handleProfileSave = async (creds: { username: string; password: string; serverUrl: string }) => {
    if (creds.password) {
      await window.svn.setCredentials(creds)
      setCredentials(creds as Credentials)
    } else {
      await window.svn.updateCredentials(creds)
      setCredentials({ username: creds.username, password: credentials?.password || '', serverUrl: creds.serverUrl } as Credentials)
    }
    setAuthInitialServerUrl(creds.serverUrl || DEFAULT_SERVER_URL)
    setShowProfileDialog(false)
    setAuthErrorDetected(false)
    toast('Credenciales actualizadas', 'success')
    await refreshRepos()
    await refreshRemotes()
  }

  const handleLogout = async () => {
    try {
      await window.svn.clearCredentials()
      setCredentials(null)
      const activeRemoteUrl = remoteServers.find((r) => r.id === activeRemoteId)?.url
      setAuthInitialServerUrl(activeRemoteUrl || authInitialServerUrl || DEFAULT_SERVER_URL)
      setShowAuthDialog(true)
      toast('Sesión cerrada. Inicia con otra cuenta.', 'info')
    } catch (err: any) {
      toast(err.message || 'No se pudo cerrar la sesión', 'error')
    }
  }

  const openExplorer = () => {
    setActiveTab('explorer')
    if (!credentials) setShowAuthDialog(true)
  }

  const handleSaveRemote = async (name: string, url: string) => {
    const saved = await window.svn.saveRemote({ name, url })
    await refreshRemotes()
    setActiveRemoteId(saved.id)
    setAuthInitialServerUrl(saved.url)
    setActiveTab('explorer')
    toast(`Remoto "${saved.name}" guardado`, 'success')
  }

  const handleSelectRemote = async (remoteId: string) => {
    try {
      const selected = await window.svn.selectRemote(remoteId)
      await refreshRemotes()
      setActiveRemoteId(selected.id)
      setAuthInitialServerUrl(selected.url)
      setActiveTab('explorer')
      if (!credentials) setShowAuthDialog(true)
    } catch (err: any) {
      toast(err.message || 'No se pudo abrir el remoto', 'error')
    }
  }

  const handleInstallSvn = async () => {
    setInstalling(true)
    setInstallLog('')
    const unsub = window.svn.onInstallProgress((msg) => {
      setInstallLog((prev) => prev + msg)
    })
    try {
      const result = await window.svn.installSvn()
      if (result.success) {
        await window.svn.getVersion()
        setSvnMissing(false)
        toast('SVN instalado correctamente', 'success')
      }
    } catch (err: any) {
      toast(err.message || 'Error al instalar SVN', 'error')
    } finally {
      unsub()
      setInstalling(false)
    }
  }

  const handleAddRemote = async () => {
    setAddRemoteUrl('')
    setAddRemoteName('')
    setShowAddRemoteDialog(true)
  }

  const handleAddRemoteSubmit = async () => {
    const url = addRemoteUrl.trim()
    if (!url) { toast('Ingresa una URL de servidor SVN', 'error'); return }
    const name = addRemoteName.trim() || url.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/').slice(-2).join('/') || 'Servidor SVN'
    try {
      await handleSaveRemote(name, url)
      setShowAddRemoteDialog(false)
    } catch (err: any) {
      toast(err.message || 'Error al guardar el servidor', 'error')
    }
  }

  const handleDeleteRemote = (remote: RemoteServer) => setRemoteToDelete(remote)

  const confirmDeleteRemote = async () => {
    if (!remoteToDelete) return
    try {
      await window.svn.deleteRemote(remoteToDelete.id)
      if (activeRemoteId === remoteToDelete.id) {
        setActiveRemoteId(null)
        setActiveTab('changes')
      }
      await refreshRemotes()
      toast(`Servidor "${remoteToDelete.name}" eliminado`, 'success')
    } catch (err: any) {
      toast(err.message || 'Error al eliminar el servidor', 'error')
    } finally {
      setRemoteToDelete(null)
    }
  }

  const handleRenameRemote = (remote: RemoteServer) => {
    setRemoteToRename(remote)
    setRenameRemoteName(remote.name)
    setRenameRemoteUrl(remote.url)
  }

  const confirmRenameRemote = async () => {
    if (!remoteToRename) return
    const name = renameRemoteName.trim()
    const url = renameRemoteUrl.trim()
    if (!name) { toast('El nombre no puede estar vacío', 'error'); return }
    if (!url) { toast('La URL no puede estar vacía', 'error'); return }
    try {
      await window.svn.renameRemote(remoteToRename.id, name, url)
      await refreshRemotes()
      if (url !== remoteToRename.url) setAuthInitialServerUrl(url)
      toast(`Servidor actualizado`, 'success')
    } catch (err: any) {
      toast(err.message || 'Error al actualizar el servidor', 'error')
    } finally {
      setRemoteToRename(null)
      setRenameRemoteName('')
      setRenameRemoteUrl('')
    }
  }

  const handleDeleteRepo = (repo: LocalRepo) => setRepoToDelete(repo)

  const handleOpenInEditor = async (editorId: EditorId, repoPath: string) => {
    try {
      await window.svn.openInEditor(editorId, repoPath)
    } catch (err: any) {
      toast(err.message || 'No se pudo abrir el repositorio en el editor', 'error')
    }
  }

  const confirmDeleteRepo = async () => {
    if (!repoToDelete) return
    const targetRepo = repoToDelete
    const wasSelected = selectedRepo?.path === targetRepo.path

    if (wasSelected) {
      setSelectedRepo(null)
      setChanges([])
      setLoadingChanges(false)
    }

    try {
      await window.svn.deleteRepo(targetRepo.path)
      await refreshRepos()
      toast(`Copia local "${targetRepo.name}" eliminada`, 'success')
    } catch (err: any) {
      if (wasSelected) setSelectedRepo(targetRepo)
      toast(err.message || 'Error al eliminar la copia local', 'error')
    } finally {
      setRepoToDelete(null)
    }
  }

  const handleCheckoutDone = async () => {
    await refreshRepos()
    const repos = await window.svn.listLocalRepos()
    if (repos.length > 0 && !selectedRepo) {
      setSelectedRepo(repos[0])
    }
  }

  const handleMigrationAction = async (action: MigrationAction) => {
    setMigrationRunning(true)
    setMigrationResult(null)
    setMigrationError(null)
    try {
      const result = await window.appMigration.runAction(action)
      setMigrationResult(result)
      const mayContinue = action === 'remind-later'
        || action === 'start-without-migration'
        || result.status === 'completed'
      setMigrationGateReady(mayContinue)
      if (mayContinue && action !== 'migrate-now') setShowMigrationDialog(false)
    } catch {
      setMigrationError('No se pudo completar la acción de migración.')
      setMigrationGateReady(false)
      if (action !== 'migrate-now') setShowMigrationDialog(false)
    } finally {
      setMigrationRunning(false)
    }
  }

  const migratedWorkingCopies = migrationResult
    ? Object.values(migrationResult.workingCopies).filter((status) => status === 'completed').length
    : 0
  const migrationCanRetry = migrationResult?.status === 'blocked' || migrationResult?.status === 'failed'

  return (
    <div className="app">
      {!migrationInspection && !showMigrationDialog && (
        <div className="overlay" style={{ zIndex: 10000 }}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-title">Preparando ArtiSVN…</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text2)', fontSize: 13 }}>
              <span className="spinner" /> Comprobando datos locales
            </div>
          </div>
        </div>
      )}

      {showMigrationDialog && (
        <div className="overlay" style={{ zIndex: 10001 }}>
          <div className="dialog" style={{ width: 520, maxWidth: '90vw' }}>
            <div className="dialog-title">JaviSVN ahora es ArtiSVN</div>
            {migrationRunning ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', color: 'var(--text2)', fontSize: 13 }}>
                <span className="spinner" /> Migrando configuración y copias locales…
              </div>
            ) : migrationResult?.status === 'completed' ? (
              <>
                <p style={{ fontSize: 13, color: 'var(--text2)', margin: '0 0 8px' }}>
                  La migración terminó correctamente. Se prepararon {migratedWorkingCopies} copia{migratedWorkingCopies === 1 ? '' : 's'} local{migratedWorkingCopies === 1 ? '' : 'es'}.
                </p>
                <div className="dialog-actions">
                  <button className="btn btn-primary" onClick={() => setShowMigrationDialog(false)}>Continuar</button>
                </div>
              </>
            ) : migrationCanRetry ? (
              <>
                <p style={{ fontSize: 13, color: 'var(--text2)', margin: '0 0 8px' }}>
                  {migrationResult?.status === 'blocked'
                    ? 'La migración se detuvo para no sobrescribir datos existentes.'
                    : 'La migración no pudo completarse. Puedes intentarlo de nuevo.'}
                </p>
                <p style={{ fontSize: 12, color: 'var(--text2)', margin: '0 0 16px' }}>
                  No se modificaron ni se muestran credenciales en este proceso.
                </p>
                <div className="dialog-actions">
                  <button className="btn btn-default" onClick={() => handleMigrationAction('start-without-migration')}>Iniciar sin migrar</button>
                  <button className="btn btn-primary" onClick={() => handleMigrationAction('migrate-now')}>Reintentar migración</button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: 'var(--text2)', margin: '0 0 8px' }}>
                  Encontramos datos de JaviSVN que puedes copiar a las rutas nuevas de ArtiSVN. Los datos originales se conservarán.
                </p>
                {migrationError && (
                  <p style={{ fontSize: 12, color: 'var(--danger)', margin: '0 0 12px' }}>{migrationError}</p>
                )}
                <div className="dialog-actions" style={{ flexWrap: 'wrap' }}>
                  <button className="btn btn-default" onClick={() => handleMigrationAction('start-without-migration')}>Iniciar sin migrar</button>
                  <button className="btn btn-default" onClick={() => handleMigrationAction('remind-later')}>Recordarme después</button>
                  <button className="btn btn-primary" onClick={() => handleMigrationAction('migrate-now')}>Migrar ahora</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* App update banner */}
      {appUpdateState && ['available', 'downloading', 'downloaded'].includes(appUpdateState.stage) && (
        <div className={`update-banner update-banner-${appUpdateState.stage}`}>
          <span>{getAppUpdateBannerText(appUpdateState)}</span>
          <button
            className="btn btn-primary"
            style={{ padding: '2px 12px', fontSize: 12 }}
            onClick={handleAppUpdateDownload}
            disabled={appUpdateState.stage === 'downloading'}
          >
            {getAppUpdateActionLabel(appUpdateState)}
          </button>
          <button
            className="btn btn-default"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() => setAppUpdateState(null)}
            disabled={appUpdateState.stage === 'downloading'}
          >
            ✕
          </button>
        </div>
      )}
      {/* Titlebar */}
      <div className="titlebar">
        <span className="titlebar-title">ArtiSVN</span>
        <div className="titlebar-update-area">
          <button
            className="titlebar-update-chip"
            onClick={() => window.svn.newWindow().catch((err: any) => toast(err.message || 'No se pudo abrir otra ventana', 'error'))}
            title="Abrir otra ventana (Cmd+N)"
          >
            +
          </button>
          {appUpdateState && appUpdateState.stage !== 'unsupported' && (
            <>
              <span className="titlebar-app-version">v{appUpdateState.currentVersion}</span>
              {appUpdateState.stage === 'available' ? (
                <button
                  className="titlebar-update-chip titlebar-update-chip-new"
                  onClick={handleAppUpdateDownload}
                  title={`v${appUpdateState.latestVersion} disponible - clic para descargar`}
                >
                  ↓
                </button>
              ) : appUpdateState.stage === 'downloading' ? (
                <button
                  className="titlebar-update-chip titlebar-update-chip-downloading"
                  disabled
                  title="Descargando actualización"
                >
                  {appUpdateState.progressPercent !== null ? `${appUpdateState.progressPercent}%` : '...'}
                </button>
              ) : appUpdateState.stage === 'downloaded' ? (
                <button
                  className="titlebar-update-chip titlebar-update-chip-downloaded"
                  onClick={handleAppUpdateDownload}
                  title="Mostrar instalador descargado"
                >
                  ✓
                </button>
              ) : appUpdateState.stage === 'checking' ? (
                <span className="spinner" style={{ width: 10, height: 10, flexShrink: 0 }} />
              ) : (
                <button
                  className="titlebar-update-chip"
                  onClick={handleAppUpdateCheck}
                  title={appUpdateState.stage === 'error' ? `Error: ${appUpdateState.error}` : 'Buscar actualizaciones'}
                >
                  {appUpdateState.stage === 'error' ? '⚠️' : '↑'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div
        className="app-body"
        ref={appBodyRef}
        style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}
      >
        {/* Sidebar */}
        <Sidebar
          repos={localRepos}
          remotes={remoteServers}
          selectedRepo={selectedRepo}
          isExplorerActive={activeTab === 'explorer'}
          activeRemoteId={activeRemoteId}
          credentials={credentials}
          onSelectRepo={handleSelectRepo}
          onSelectRemote={handleSelectRemote}
          onAddRemote={handleAddRemote}
          onRefresh={refreshRepos}
          onDeleteRepo={handleDeleteRepo}
          onOpenFolder={(path) => window.svn.openFolder(path)}
          availableEditors={availableEditors}
          onOpenInEditor={handleOpenInEditor}
          onDeleteRemote={handleDeleteRemote}
          onRenameRemote={handleRenameRemote}
          onOpenProfile={() => setShowProfileDialog(true)}
          onOpenAgentIntegration={() => setShowAgentIntegrationDialog(true)}
        />
        <VerticalResizeHandle
          active={isSidebarResizing}
          label="Ajustar ancho de la barra lateral"
          valueNow={sidebarWidth}
          valueMin={220}
          valueMax={420}
          {...sidebarResizeHandleProps}
        />

        {/* Main area */}
        <div className="main">
          {activeTab === 'explorer' ? (
            <ExplorerView
              credentials={credentials}
              activeRemote={remoteServers.find((r) => r.id === activeRemoteId) || null}
              onSaveRemote={handleSaveRemote}
              onCheckoutDone={handleCheckoutDone}
              onRequestCredentials={handleRequestCredentials}
              onLogout={handleLogout}
              toast={toast}
            />
          ) : selectedRepo ? (
            <>
              {/* Toolbar */}
              <div className="toolbar">
                <div className="toolbar-repo-name">{selectedRepo.name}</div>
                <div className="toolbar-branch">
                  <span>🌿</span>
                  <span>main (r{selectedRepo.revision})</span>
                </div>
                <button
                  className="btn btn-default"
                  onClick={() => window.svn.openFolder(selectedRepo.path)}
                >
                  📂 Abrir carpeta
                </button>
                {hasIncompleteWorkingCopy && (
                  <button
                    className="btn btn-default"
                    onClick={handleRepairWorkingCopy}
                    disabled={updating}
                    title="Ejecutar svn cleanup y luego svn update"
                  >
                    🧹 Reparar working copy
                  </button>
                )}
                <button
                  className="btn btn-primary"
                  onClick={handleUpdate}
                  disabled={updating}
                >
                  {updating ? '⟳ Actualizando...' : '⟳ Actualizar'}
                </button>
              </div>

              {/* Tab bar */}
              <div className="tabbar">
                <div
                  className={`tab ${activeTab === 'changes' ? 'active' : ''}`}
                  onClick={() => setActiveTab('changes')}
                >
                  Cambios
                  {changes.length > 0 && (
                    <span className="tab-badge">{changes.length}</span>
                  )}
                </div>
                <div
                  className={`tab ${activeTab === 'history' ? 'active' : ''}`}
                  onClick={() => setActiveTab('history')}
                >
                  Historial
                </div>
              </div>

              {/* Content — wrapped in tab-content for fade-in animation on tab switch */}
              {activeTab === 'changes' && (
                <div key="changes" className="tab-content">
                  <ChangesView
                    repo={selectedRepo}
                    changes={changes}
                    loading={loadingChanges}
                    onRefresh={loadChanges}
                    toast={toast}
                  />
                </div>
              )}
              {activeTab === 'history' && (
                <div key="history" className="tab-content">
                  <HistoryView
                    repo={selectedRepo}
                    toast={toast}
                    onWorkingCopyChanged={async () => {
                      await loadChanges({ silent: true })
                      await refreshRepos()
                    }}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="welcome">
              <div className="empty-state">
                <div className="empty-state-icon">📦</div>
                <div className="empty-state-title">No hay repositorios locales</div>
                <div className="empty-state-sub">
                  Usa el Explorador SVN para clonar repositorios del servidor
                </div>
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 12 }}
                  onClick={openExplorer}
                >
                  Explorar repositorios
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Auth Dialog */}
      {showAuthDialog && (
        <AuthDialog
          onSave={handleAuthSave}
          onCancel={() => {
            setShowAuthDialog(false)
            setAuthErrorDetected(false)
          }}
          initialServerUrl={authInitialServerUrl}
          authError={authErrorDetected}
        />
      )}

      {/* Profile Dialog */}
      {showProfileDialog && credentials && (
        <ProfileDialog
          currentUsername={credentials.username}
          currentServerUrl={authInitialServerUrl}
          onSave={handleProfileSave}
          onCancel={() => {
            setShowProfileDialog(false)
            setAuthErrorDetected(false)
          }}
          authError={authErrorDetected}
        />
      )}

      {showAgentIntegrationDialog && (
        <AgentIntegrationDialog
          onClose={() => setShowAgentIntegrationDialog(false)}
          toast={toast}
        />
      )}

      {/* Update progress */}
      {showUpdateProgress && (
        <div className="progress-overlay">
          <div className="progress-box">
            <div className="progress-title">⟳ Actualizando repositorio...</div>
            <div className="progress-log">{updateLog}</div>
            <div className="progress-bar-wrap">
              <div className="progress-bar" style={{ width: '60%' }} />
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span className="toast-icon">
              {t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'}
            </span>
            <span className="toast-message">{t.message}</span>
          </div>
        ))}
      </div>

      {/* Delete repo confirmation */}
      {repoToDelete && (
        <div className="overlay">
          <div className="dialog" style={{ width: 400 }}>
            <div className="dialog-title">🗑 Eliminar copia local</div>
            <p style={{ fontSize: 13, color: 'var(--text2)', margin: '0 0 8px' }}>
              ¿Eliminar la copia local de <strong style={{ color: 'var(--text1)' }}>{repoToDelete.name}</strong>?
            </p>
            <p style={{ fontSize: 12, color: 'var(--text2)', margin: '0 0 16px' }}>
              Esto borrará permanentemente la carpeta local. Los archivos en el servidor SVN no se verán afectados.
            </p>
            <div className="dialog-actions">
              <button className="btn btn-default" onClick={() => setRepoToDelete(null)}>Cancelar</button>
              <button className="btn btn-danger" onClick={confirmDeleteRepo}>Eliminar</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete remote confirmation */}
      {remoteToDelete && (
        <div className="overlay">
          <div className="dialog" style={{ width: 400 }}>
            <div className="dialog-title">🗑 Eliminar servidor remoto</div>
            <p style={{ fontSize: 13, color: 'var(--text2)', margin: '0 0 8px' }}>
              ¿Eliminar <strong style={{ color: 'var(--text1)' }}>{remoteToDelete.name}</strong>?
            </p>
            <p style={{ fontSize: 12, color: 'var(--text2)', margin: '0 0 16px' }}>
              Solo se elimina de la lista de favoritos. El repositorio en el servidor SVN no se verá afectado.
            </p>
            <div className="dialog-actions">
              <button className="btn btn-default" onClick={() => setRemoteToDelete(null)}>Cancelar</button>
              <button className="btn btn-danger" onClick={confirmDeleteRemote}>Eliminar</button>
            </div>
          </div>
        </div>
      )}

      {/* Rename remote dialog */}
      {remoteToRename && (
        <div className="overlay">
          <div className="dialog" style={{ width: 480 }}>
            <div className="dialog-title">✏️ Editar servidor</div>
            <div className="form-field">
              <label className="form-label">Nombre</label>
              <input
                className="form-input"
                value={renameRemoteName}
                onChange={(e) => setRenameRemoteName(e.target.value)}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') confirmRenameRemote(); if (e.key === 'Escape') setRemoteToRename(null) }}
              />
            </div>
            <div className="form-field">
              <label className="form-label">URL</label>
              <input
                className="form-input"
                value={renameRemoteUrl}
                onChange={(e) => setRenameRemoteUrl(e.target.value)}
                placeholder="https://servidor/svn"
                onKeyDown={(e) => { if (e.key === 'Enter') confirmRenameRemote(); if (e.key === 'Escape') setRemoteToRename(null) }}
              />
            </div>
            <div className="dialog-actions">
              <button className="btn btn-default" onClick={() => setRemoteToRename(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={confirmRenameRemote} disabled={!renameRemoteName.trim() || !renameRemoteUrl.trim()}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add remote server dialog */}
      {showAddRemoteDialog && (
        <div className="overlay">
          <div className="dialog" style={{ width: 480 }}>
            <div className="dialog-title">➕ Agregar servidor SVN</div>
            <div className="form-field">
              <label className="form-label">URL del servidor</label>
              <input
                className="form-input"
                value={addRemoteUrl}
                onChange={(e) => setAddRemoteUrl(e.target.value)}
                placeholder="https://servidor/svn"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddRemoteSubmit() }}
              />
            </div>
            <div className="form-field">
              <label className="form-label">Nombre (opcional)</label>
              <input
                className="form-input"
                value={addRemoteName}
                onChange={(e) => setAddRemoteName(e.target.value)}
                placeholder="Mi Servidor SVN"
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddRemoteSubmit() }}
              />
            </div>
            <div className="dialog-actions">
              <button className="btn btn-default" onClick={() => setShowAddRemoteDialog(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleAddRemoteSubmit} disabled={!addRemoteUrl.trim()}>
                Agregar y explorar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SVN not found — auto install dialog */}
      {svnMissing && (
        <div className="progress-overlay">
          <div className="progress-box" style={{ maxWidth: 480 }}>
            <div className="progress-title" style={{ fontSize: 15, marginBottom: 8 }}>
              SVN no encontrado
            </div>
            <p style={{ fontSize: 13, color: 'var(--text2)', margin: '0 0 16px' }}>
              SVN no está instalado en este sistema. ArtiSVN lo puede instalar
              automáticamente usando Homebrew.
            </p>
            {installing ? (
              <>
                <div className="progress-log" style={{ minHeight: 120 }}>{installLog || 'Iniciando instalacion...'}</div>
                <div className="progress-bar-wrap" style={{ marginTop: 12 }}>
                  <div className="progress-bar" style={{ width: '100%', animation: 'progress-indeterminate 1.5s ease-in-out infinite' }} />
                </div>
                <p style={{ fontSize: 11, color: 'var(--text2)', marginTop: 8 }}>
                  Esto puede tardar unos minutos...
                </p>
              </>
            ) : (
              <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleInstallSvn}>
                Instalar SVN automaticamente
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
