import { app, BrowserWindow, dialog } from 'electron'
import type { MessageBoxOptions } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ensureAgentIntegrationToken, getAgentIntegrationState, regenerateAgentIntegrationToken, setAgentIntegrationEnabled } from '../services/store'
import { resolveLocalPaths } from '../services/local-paths'
import {
  listLocalRepos,
  listRemote,
  localBlame,
  localDiff,
  localFileContent,
  localLog,
  localRevisionFileDiff,
  localStatus,
  remoteFileContent,
  remoteInfo,
  remoteLog,
  remoteRepoRoot,
  remoteRevisionDiff,
  resolveLocalRepo,
  resolveRemoteTarget,
  searchRemote,
  svnInfo
} from '../services/read-ops'
import { listRemotes } from '../services/store'
import { checkoutRemoteToLocalRepo, deriveCheckoutTargetName, sanitizeLocalRepoName } from '../services/checkout'
import { updateLocalRepo } from '../services/update'
import { buildAgentClientEnvironment, buildAgentClientLaunchConfig } from './client-config'
import { AgentActivityLog } from './activity-log'
import { AgentBrokerServer } from './broker'
import { resolveAgentBrokerEndpoint } from './endpoint'
import { AgentActivityEntry, AgentSession, BrokerRequest, createActivityEntry } from './protocol'
import { sanitizeLocalRepo, sanitizeRemoteEntry } from './sanitize'

export interface AgentIntegrationPublicState {
  enabled: boolean
  brokerRunning: boolean
  sessions: AgentSession[]
  activity: AgentActivityEntry[]
}

function getAgentDataDirectory(): string {
  const directory = resolveLocalPaths({
    appDataPath: app.getPath('appData')
  }).appDirectory
  mkdirSync(directory, { recursive: true })
  return directory
}

export function getAgentBrokerEndpoint(): string {
  return resolveAgentBrokerEndpoint({
    platform: process.platform,
    userDataPath: process.platform === 'win32' ? '' : getAgentDataDirectory()
  })
}

let activityLog: AgentActivityLog | null = null
let broker: AgentBrokerServer | null = null

function getActivityLog(): AgentActivityLog {
  if (!activityLog) {
    activityLog = new AgentActivityLog(join(getAgentDataDirectory(), 'artisvn-agent-activity.json'))
  }
  return activityLog
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function appendActivity(entry: AgentActivityEntry): void {
  const activity = getActivityLog().append(entry)
  broadcast('agentIntegration:activity', activity)
}

function buildTarget(method: string, params: Record<string, unknown>): string | undefined {
  if (typeof params.repoId === 'string') return `${method}:${params.repoId}`
  if (typeof params.remoteId === 'string') return `${method}:${params.remoteId}`
  if (typeof params.url === 'string') return `${method}:${params.url}`
  return method
}

function getDialogOwnerWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
}

async function confirmAgentCheckout(
  session: AgentSession,
  url: string,
  targetName: string,
  revision?: number
): Promise<void> {
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: ['Cancelar', 'Hacer checkout'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirmar checkout solicitado por IA',
    message: 'Un cliente MCP quiere crear una copia local',
    detail:
      `${session.clientName} solicitó checkout de:\n${url}` +
      `${revision ? `\nRevisión: r${revision}` : ''}` +
      `\nDestino local: ${targetName}\n\n` +
      'La copia se guardará en la carpeta local de ArtiSVN y aparecerá en la lista de repositorios.'
  }
  const ownerWindow = getDialogOwnerWindow()
  const { response } = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options)

  if (response !== 1) {
    throw new Error('Checkout cancelado por el usuario')
  }
}

async function confirmAgentUpdate(session: AgentSession, repo: {
  name: string
  url: string
  revision: number
}): Promise<void> {
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: ['Cancelar', 'Actualizar'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirmar actualización solicitada por IA',
    message: 'Un cliente MCP quiere actualizar una copia local',
    detail:
      `${session.clientName} solicitó actualizar:\n${repo.name}` +
      `${repo.url ? `\n${repo.url}` : ''}` +
      `\nRevisión actual: r${repo.revision}\n\n` +
      'La working copy local puede recibir cambios nuevos del servidor SVN.'
  }
  const ownerWindow = getDialogOwnerWindow()
  const { response } = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options)

  if (response !== 1) {
    throw new Error('Actualización cancelada por el usuario')
  }
}

async function handleBrokerRequest(
  session: AgentSession,
  request: BrokerRequest,
  emitProgress: (progress: unknown) => void
): Promise<unknown> {
  const started = Date.now()
  const params = request.params || {}
  let kind: 'tool' | 'resource' = 'tool'
  try {
    let result: unknown
    switch (request.method) {
      case 'list_remotes':
        result = listRemotes()
        break
      case 'list_local_repos':
        result = (await listLocalRepos()).map(sanitizeLocalRepo)
        break
      case 'local_status': {
        const repo = await resolveLocalRepo(String(params.repoId || ''))
        result = await localStatus(repo.path)
        break
      }
      case 'local_diff': {
        const repo = await resolveLocalRepo(String(params.repoId || ''))
        result = await localDiff(repo.path, String(params.filePath || ''))
        break
      }
      case 'local_file_content': {
        const repo = await resolveLocalRepo(String(params.repoId || ''))
        result = localFileContent(repo.path, String(params.filePath || ''))
        break
      }
      case 'local_log': {
        const repo = await resolveLocalRepo(String(params.repoId || ''))
        result = await localLog(repo.path, Number(params.limit || 50), params.fromRevision ? Number(params.fromRevision) : undefined)
        break
      }
      case 'local_blame': {
        const repo = await resolveLocalRepo(String(params.repoId || ''))
        result = await localBlame(repo.path, String(params.filePath || ''))
        break
      }
      case 'local_revision_file_diff': {
        const repo = await resolveLocalRepo(String(params.repoId || ''))
        result = await localRevisionFileDiff(
          repo.path,
          Number(params.revision),
          String(params.svnPath || '')
        )
        break
      }
      case 'local_info': {
        const repo = await resolveLocalRepo(String(params.repoId || ''))
        result = await svnInfo(repo.path)
        break
      }
      case 'remote_list':
        result = (await listRemote(
          resolveRemoteTarget(params),
          params.revision === undefined ? undefined : Number(params.revision)
        )).map(sanitizeRemoteEntry)
        break
      case 'remote_search':
        result = await searchRemote(
          resolveRemoteTarget(params),
          String(params.query || ''),
          Boolean(params.deepSearch),
          {
            maxResults: Number(params.maxResults || 200),
            onProgress: emitProgress,
            revision: params.revision === undefined ? undefined : Number(params.revision)
          }
        )
        break
      case 'remote_log':
        result = await remoteLog(
          resolveRemoteTarget(params),
          Number(params.limit || 50),
          params.revision === undefined ? undefined : Number(params.revision)
        )
        break
      case 'remote_file_content':
        result = await remoteFileContent(
          resolveRemoteTarget(params),
          params.revision === undefined ? undefined : Number(params.revision)
        )
        break
      case 'remote_repo_root':
        result = await remoteRepoRoot(
          resolveRemoteTarget(params),
          params.revision === undefined ? undefined : Number(params.revision)
        )
        break
      case 'remote_revision_diff':
        result = await remoteRevisionDiff(
          resolveRemoteTarget(params),
          String(params.svnPath || ''),
          Number(params.revision)
        )
        break
      case 'remote_info':
        result = await remoteInfo(
          resolveRemoteTarget(params),
          params.revision === undefined ? undefined : Number(params.revision)
        )
        break
      case 'checkout_remote': {
        const url = resolveRemoteTarget(params)
        const revision = params.revision === undefined ? undefined : Number(params.revision)
        const targetName = sanitizeLocalRepoName(
          typeof params.targetName === 'string' && params.targetName.trim()
            ? params.targetName
            : deriveCheckoutTargetName(url)
        )
        await confirmAgentCheckout(session, url, targetName, revision)
        const checkout = await checkoutRemoteToLocalRepo(url, targetName, { revision })
        const repo = (await listLocalRepos()).find((candidate) => candidate.path === checkout.path)
        result = {
          success: true,
          repo: repo ? sanitizeLocalRepo(repo) : null
        }
        break
      }
      case 'update_local_repo': {
        const repo = await resolveLocalRepo(String(params.repoId || ''))
        await confirmAgentUpdate(session, repo)
        await updateLocalRepo(repo.path)
        const updatedRepo = await resolveLocalRepo(repo.id)
        result = {
          success: true,
          repo: sanitizeLocalRepo(updatedRepo)
        }
        break
      }
      case 'resource:remotes':
        kind = 'resource'
        result = listRemotes()
        break
      case 'resource:repos':
        kind = 'resource'
        result = (await listLocalRepos()).map(sanitizeLocalRepo)
        break
      case 'resource:repo_status': {
        kind = 'resource'
        const repo = await resolveLocalRepo(String(params.repoId || ''))
        result = await localStatus(repo.path)
        break
      }
      default:
        throw new Error(`Método MCP no soportado: ${request.method}`)
    }

    appendActivity(createActivityEntry({
      kind,
      clientId: session.clientId,
      clientName: session.clientName,
      action: request.method,
      target: buildTarget(request.method, params),
      ok: true,
      durationMs: Date.now() - started
    }))
    return result
  } catch (error) {
    appendActivity(createActivityEntry({
      kind,
      clientId: session.clientId,
      clientName: session.clientName,
      action: request.method,
      target: buildTarget(request.method, params),
      ok: false,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'Error interno'
    }))
    throw error
  }
}

function buildBroker(): AgentBrokerServer {
  return new AgentBrokerServer({
    endpoint: getAgentBrokerEndpoint(),
    getToken: () => getAgentIntegrationState().token,
    handleRequest: handleBrokerRequest,
    onSessionConnected: (session) => {
      appendActivity(createActivityEntry({
        kind: 'connect',
        clientId: session.clientId,
        clientName: session.clientName,
        action: 'connect',
        ok: true
      }))
      broadcast('agentIntegration:state', getAgentIntegrationPublicState())
    },
    onSessionDisconnected: (session) => {
      appendActivity(createActivityEntry({
        kind: 'disconnect',
        clientId: session.clientId,
        clientName: session.clientName,
        action: 'disconnect',
        ok: true
      }))
      broadcast('agentIntegration:state', getAgentIntegrationPublicState())
    }
  })
}

export async function startAgentBrokerIfEnabled(): Promise<void> {
  const state = getAgentIntegrationState()
  if (!state.enabled) return
  ensureAgentIntegrationToken()
  if (!broker) broker = buildBroker()
  try {
    await broker.start()
  } catch (error) {
    broker = null
    throw error
  }
  broadcast('agentIntegration:state', getAgentIntegrationPublicState())
}

export async function stopAgentBroker(): Promise<void> {
  if (!broker) return
  await broker.stop()
  broker = null
  broadcast('agentIntegration:state', getAgentIntegrationPublicState())
}

export function getAgentIntegrationPublicState(): AgentIntegrationPublicState {
  const state = getAgentIntegrationState()
  return {
    enabled: state.enabled,
    brokerRunning: Boolean(broker?.isRunning()),
    sessions: broker?.listSessions() || [],
    activity: getActivityLog().list()
  }
}

export async function setAgentIntegrationPublicEnabled(enabled: boolean): Promise<AgentIntegrationPublicState> {
  setAgentIntegrationEnabled(enabled)
  if (enabled) {
    await startAgentBrokerIfEnabled()
  } else {
    broker?.disconnectAll()
    await stopAgentBroker()
  }
  return getAgentIntegrationPublicState()
}

export async function regenerateAgentIntegrationPublicToken(): Promise<AgentIntegrationPublicState> {
  regenerateAgentIntegrationToken()
  broker?.disconnectAll()
  broadcast('agentIntegration:state', getAgentIntegrationPublicState())
  return getAgentIntegrationPublicState()
}

export function clearAgentActivity(): AgentActivityEntry[] {
  getActivityLog().clear()
  const activity: AgentActivityEntry[] = []
  broadcast('agentIntegration:activity', activity)
  return activity
}

export function getAgentClientConfig(): {
  command: string
  args: string[]
  env: Record<string, string>
} {
  const token = ensureAgentIntegrationToken()
  const launchArgs = app.isPackaged ? ['--mcp-stdio'] : [app.getAppPath(), '--mcp-stdio']

  // Resolver ruta al bridge MCP standalone en macOS/Linux empaquetado.
  const mcpBridgeExePath = (() => {
    if (!app.isPackaged) return undefined
    if (process.platform === 'darwin' || process.platform === 'linux') {
      return join(process.resourcesPath, 'bridge', 'artisvn-mcp-bridge')
    }
    return undefined
  })()

  const launchConfig = buildAgentClientLaunchConfig({
    platform: process.platform,
    execPath: process.execPath,
    launchArgs,
    comSpec: process.env.ComSpec,
    stdioEnvKey: 'ARTISVN_MCP_STDIO',
    mcpBridgeExeName: app.isPackaged && process.platform === 'win32' ? 'ArtiSvnMcp.exe' : undefined,
    mcpBridgeExePath
  })

  return {
    ...launchConfig,
    env: buildAgentClientEnvironment(token)
  }
}
