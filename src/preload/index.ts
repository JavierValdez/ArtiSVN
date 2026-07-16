import { contextBridge, ipcRenderer } from 'electron'

interface StoredCredentialsPayload {
  username?: string
  password?: string
  serverUrl?: string
}

function sanitizeCredentialsForRenderer(creds: StoredCredentialsPayload | null) {
  if (!creds) return null

  return {
    username: creds.username || '',
    serverUrl: creds.serverUrl || '',
    hasPassword: Boolean(creds.password)
  }
}

async function invokeWithTransientPassword(
  channel: string,
  creds: { username: string; password: string; serverUrl: string }
) {
  const payload = { ...creds }
  try {
    return await ipcRenderer.invoke(channel, payload)
  } finally {
    // Avoid retaining the real SVN password in renderer-owned objects after IPC serialization.
    creds.password = ''
  }
}

const svnAPI = {
  // Credentials
  getCredentials: async () => sanitizeCredentialsForRenderer(await ipcRenderer.invoke('creds:get')),
  setCredentials: (creds: { username: string; password: string; serverUrl: string }) =>
    invokeWithTransientPassword('creds:set', creds),
  updateCredentials: (creds: { username: string; password: string; serverUrl: string }) =>
    invokeWithTransientPassword('creds:update', creds),
  clearCredentials: () => ipcRenderer.invoke('creds:clear'),
  getServerUrl: () => ipcRenderer.invoke('creds:getServerUrl'),
  setServerUrl: (serverUrl: string) => ipcRenderer.invoke('creds:setServerUrl', serverUrl),
  listRemotes: () => ipcRenderer.invoke('remotes:list'),
  saveRemote: (remote: { name: string; url: string }) => ipcRenderer.invoke('remotes:save', remote),
  selectRemote: (remoteId: string) => ipcRenderer.invoke('remotes:select', remoteId),
  deleteRemote: (remoteId: string) => ipcRenderer.invoke('remotes:delete', remoteId),
  renameRemote: (remoteId: string, name: string, url?: string) => ipcRenderer.invoke('remotes:rename', remoteId, name, url),

  // Local repos
  listLocalRepos: () => ipcRenderer.invoke('repos:list'),
  getBasePath: () => ipcRenderer.invoke('repos:basePath'),
  deleteRepo: (repoPath: string) => ipcRenderer.invoke('repos:delete', repoPath),

  // Remote SVN
  listRemote: (url: string) => ipcRenderer.invoke('svn:list', url),
  searchRemote: (url: string, query: string, deepSearch: boolean) =>
    ipcRenderer.invoke('svn:searchRemote', url, query, deepSearch),
  remoteLog: (url: string, limit?: number) => ipcRenderer.invoke('svn:remoteLog', url, limit),
  remoteFileContent: (url: string) => ipcRenderer.invoke('svn:cat', url),
  getRepoRoot: (url: string) => ipcRenderer.invoke('svn:getRepoRoot', url),
  remoteRevisionDiff: (baseUrl: string, svnPath: string, revision: number) =>
    ipcRenderer.invoke('svn:remoteRevisionDiff', baseUrl, svnPath, revision),
  remoteMkdir: (parentUrl: string, name: string, message?: string) =>
    ipcRenderer.invoke('svn:remoteMkdir', parentUrl, name, message),
  remoteCreateFile: (parentUrl: string, name: string, content?: string, message?: string) =>
    ipcRenderer.invoke('svn:remoteCreateFile', parentUrl, name, content, message),
  svnExport: (url: string, targetPath: string) => ipcRenderer.invoke('svn:export', url, targetPath),
  pickExportFolder: () => ipcRenderer.invoke('dialog:pickExportFolder'),
  downloadFile: (url: string, defaultName: string) => ipcRenderer.invoke('svn:downloadFile', url, defaultName),
  ping: (url: string) => ipcRenderer.invoke('svn:ping', url),
  pingWithCreds: (creds: { url: string; username: string; password: string }) =>
    ipcRenderer.invoke('svn:pingWithCreds', creds),
  getVersion: () => ipcRenderer.invoke('svn:version'),
  getBinPath: () => ipcRenderer.invoke('svn:getBinPath'),
  setBinPath: (binPath: string) => ipcRenderer.invoke('svn:setBinPath', binPath),

  // Repo operations
  checkout: (url: string, targetName: string) =>
    ipcRenderer.invoke('svn:checkout', url, targetName),
  update: (repoPath: string) => ipcRenderer.invoke('svn:update', repoPath),
  cleanup: (repoPath: string) => ipcRenderer.invoke('svn:cleanup', repoPath),
  status: (repoPath: string) => ipcRenderer.invoke('svn:status', repoPath),
  diff: (repoPath: string, filePath: string) => ipcRenderer.invoke('svn:diff', repoPath, filePath),
  fileContent: (repoPath: string, filePath: string) => ipcRenderer.invoke('svn:fileContent', repoPath, filePath),
  getLocalPreviewFile: (repoPath: string, filePath: string) => ipcRenderer.invoke('svn:getLocalPreviewFile', repoPath, filePath),
  getRemotePreviewFile: (url: string, defaultName: string) => ipcRenderer.invoke('svn:getRemotePreviewFile', url, defaultName),
  add: (repoPath: string, filePath: string, scope: 'item' | 'branch' = 'item') =>
    ipcRenderer.invoke('svn:add', repoPath, filePath, scope),
  ignore: (repoPath: string, filePath: string, scope: 'item' | 'branch' = 'item') =>
    ipcRenderer.invoke('svn:ignore', repoPath, filePath, scope),
  getConflictContent: (repoPath: string, filePath: string) =>
    ipcRenderer.invoke('svn:getConflictContent', repoPath, filePath),
  revisionFileDiff: (repoPath: string, revision: number, svnPath: string) =>
    ipcRenderer.invoke('svn:revisionFileDiff', repoPath, revision, svnPath),
  restorePathAtRevision: (repoPath: string, revision: number, svnPath: string, action: 'A' | 'M' | 'D' | 'R') =>
    ipcRenderer.invoke('svn:restorePathAtRevision', repoPath, revision, svnPath, action),
  blame: (repoPath: string, filePath: string) => ipcRenderer.invoke('svn:blame', repoPath, filePath),
  commit: (repoPath: string, files: string[], message: string) =>
    ipcRenderer.invoke('svn:commit', repoPath, files, message),
  revert: (repoPath: string, files: string[]) =>
    ipcRenderer.invoke('svn:revert', repoPath, files),
  resolve: (repoPath: string, filePath: string, accept: 'mine-full' | 'theirs-full' | 'working') =>
    ipcRenderer.invoke('svn:resolve', repoPath, filePath, accept),
  log: (repoPath: string, limit?: number, fromRevision?: number) =>
    ipcRenderer.invoke('svn:log', repoPath, limit, fromRevision),
  info: (path: string) => ipcRenderer.invoke('svn:info', path),

  // Dialog / shell
  openFile: (repoPath: string, filePath: string) =>
    ipcRenderer.invoke('dialog:openFile', repoPath, filePath),
  openFolder: (path: string) => ipcRenderer.invoke('dialog:openFolder', path),
  listEditors: () => ipcRenderer.invoke('dialog:listEditors'),
  openInEditor: (editorId: string, repoPath: string) =>
    ipcRenderer.invoke('dialog:openInEditor', editorId, repoPath),
  newWindow: () => ipcRenderer.invoke('app:newWindow'),

  // Install SVN via Homebrew (fallback when no bundled binary)
  installSvn: () => ipcRenderer.invoke('svn:install'),

  // Event listeners
  onCheckoutProgress: (cb: (msg: string) => void) => {
    const handler = (_: any, msg: string) => cb(msg)
    ipcRenderer.on('svn:checkout-progress', handler)
    return () => ipcRenderer.removeListener('svn:checkout-progress', handler)
  },
  onUpdateProgress: (cb: (msg: string) => void) => {
    const handler = (_: any, msg: string) => cb(msg)
    ipcRenderer.on('svn:update-progress', handler)
    return () => ipcRenderer.removeListener('svn:update-progress', handler)
  },
  onInstallProgress: (cb: (msg: string) => void) => {
    const handler = (_: any, msg: string) => cb(msg)
    ipcRenderer.on('svn:install-progress', handler)
    return () => ipcRenderer.removeListener('svn:install-progress', handler)
  },
  onSearchResult: (cb: (result: any) => void) => {
    const handler = (_: any, result: any) => cb(result)
    ipcRenderer.on('svn:searchResult', handler)
    return () => ipcRenderer.removeListener('svn:searchResult', handler)
  },
  onSearchProgress: (cb: (data: { searched: number; total: number }) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on('svn:searchProgress', handler)
    return () => ipcRenderer.removeListener('svn:searchProgress', handler)
  },
  onSearchDone: (cb: (data: { searched: number; total: number }) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on('svn:searchDone', handler)
    return () => ipcRenderer.removeListener('svn:searchDone', handler)
  },
  onExportProgress: (cb: (msg: string) => void) => {
    const handler = (_: any, msg: string) => cb(msg)
    ipcRenderer.on('svn:export-progress', handler)
    return () => ipcRenderer.removeListener('svn:export-progress', handler)
  },

  // App updates
  getUpdateState: () => ipcRenderer.invoke('appUpdate:getState'),
  checkForUpdates: () => ipcRenderer.invoke('appUpdate:check'),
  downloadUpdate: () => ipcRenderer.invoke('appUpdate:download'),
  onAppUpdateState: (cb: (state: any) => void) => {
    const handler = (_: any, state: any) => cb(state)
    ipcRenderer.on('appUpdate:state', handler)
    return () => ipcRenderer.removeListener('appUpdate:state', handler)
  }
}

const appMigrationAPI = {
  inspect: () => ipcRenderer.invoke('appMigration:inspect'),
  runAction: (action: 'migrate-now' | 'remind-later' | 'start-without-migration') =>
    ipcRenderer.invoke('appMigration:runAction', action)
}

const appUpdateAPI = {
  getState: () => ipcRenderer.invoke('appUpdate:getState'),
  check: () => ipcRenderer.invoke('appUpdate:check'),
  download: () => ipcRenderer.invoke('appUpdate:download'),
  onState: (cb: (state: any) => void) => {
    const handler = (_: any, state: any) => cb(state)
    ipcRenderer.on('appUpdate:state', handler)
    return () => ipcRenderer.removeListener('appUpdate:state', handler)
  }
}

const agentIntegrationAPI = {
  getState: () => ipcRenderer.invoke('agentIntegration:getState'),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke('agentIntegration:setEnabled', enabled),
  getClientConfig: () => ipcRenderer.invoke('agentIntegration:getClientConfig'),
  regenerateToken: () => ipcRenderer.invoke('agentIntegration:regenerateToken'),
  getActivity: () => ipcRenderer.invoke('agentIntegration:getActivity'),
  clearActivity: () => ipcRenderer.invoke('agentIntegration:clearActivity'),
  onState: (cb: (state: any) => void) => {
    const handler = (_: any, state: any) => cb(state)
    ipcRenderer.on('agentIntegration:state', handler)
    return () => ipcRenderer.removeListener('agentIntegration:state', handler)
  },
  onActivity: (cb: (activity: any[]) => void) => {
    const handler = (_: any, activity: any[]) => cb(activity)
    ipcRenderer.on('agentIntegration:activity', handler)
    return () => ipcRenderer.removeListener('agentIntegration:activity', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('appUpdate', appUpdateAPI)
    contextBridge.exposeInMainWorld('appMigration', appMigrationAPI)
    contextBridge.exposeInMainWorld('agentIntegration', agentIntegrationAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(globalThis as any).appUpdate = appUpdateAPI
  ;(globalThis as any).appMigration = appMigrationAPI
  ;(globalThis as any).agentIntegration = agentIntegrationAPI
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('svn', svnAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(globalThis as any).svn = svnAPI
}
