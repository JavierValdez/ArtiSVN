import { BrowserWindow, clipboard } from 'electron'
import {
  clearAgentActivity,
  getAgentClientConfig,
  getAgentIntegrationPublicState,
  regenerateAgentIntegrationPublicToken,
  setAgentIntegrationPublicEnabled
} from '../agent/integration'
import { inspectAppMigration, runAppMigrationAction, type MigrationAction } from '../services/app-migration'
import { handleTrusted } from './guard'

export interface AppIpcContext {
  getMigrationOptions: () => { appDataPath: string; documentsPath: string }
  onMigrationResolved: () => Promise<void>
  openNewWindow: (source: BrowserWindow | null) => void
}

const REDACTED = '•••••• (se incluye al usar Copiar)'

/** The MCP token never reaches the renderer: it is shown redacted and copied from main. */
function redactClientConfig() {
  const config = getAgentClientConfig()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.env)) {
    env[key] = /TOKEN/i.test(key) ? REDACTED : value
  }
  return { ...config, env }
}

export function registerAppIpc(context: AppIpcContext): void {
  handleTrusted('appMigration:inspect', () => inspectAppMigration(context.getMigrationOptions()))

  handleTrusted('appMigration:runAction', async (_event, action: unknown) => {
    if (action !== 'migrate-now' && action !== 'remind-later' && action !== 'start-without-migration') {
      throw new Error('Acción de migración no soportada')
    }
    const result = runAppMigrationAction(action as MigrationAction, context.getMigrationOptions())
    await context.onMigrationResolved()
    return result
  })

  handleTrusted('app:newWindow', async (event) => {
    context.openNewWindow(BrowserWindow.fromWebContents(event.sender))
    return true
  })

  handleTrusted('agentIntegration:getState', () => getAgentIntegrationPublicState())
  handleTrusted('agentIntegration:setEnabled', async (_event, enabled: unknown) =>
    setAgentIntegrationPublicEnabled(enabled === true))
  handleTrusted('agentIntegration:getClientConfig', () => redactClientConfig())
  handleTrusted('agentIntegration:copyClientConfig', () => {
    clipboard.writeText(JSON.stringify({ mcpServers: { artisvn: getAgentClientConfig() } }, null, 2))
    return true
  })
  handleTrusted('agentIntegration:regenerateToken', async () => regenerateAgentIntegrationPublicToken())
  handleTrusted('agentIntegration:getActivity', () => getAgentIntegrationPublicState().activity)
  handleTrusted('agentIntegration:clearActivity', () => clearAgentActivity())
}
