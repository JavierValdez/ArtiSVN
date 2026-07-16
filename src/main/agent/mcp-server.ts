import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { AgentBrokerClient } from './broker-client'
import { getAgentBrokerEndpoint } from './integration'
import { MCP_DISPLAY_NAME, MCP_ENV, MCP_SERVER_NAME, resolveMcpEnv } from './identity'
import { registerResources, registerTools } from './mcp-surface'

interface TrackedSpawn {
  pid: number
  spawnedAt: number
  mustKillOnShutdown: boolean
}
const trackedSpawns = new Set<TrackedSpawn>()

function logMcp(event: string): void {
  if (resolveMcpEnv(process.env, MCP_ENV.debug, MCP_ENV.legacyDebug) !== '1') return
  process.stderr.write(`[${MCP_DISPLAY_NAME} MCP] ${new Date().toISOString()} ${event}\n`)
}

function buildVisibleAppEnv(): Record<string, string | undefined> {
  const ALLOWED = new Set([
    'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'LOGNAME', 'SHELL', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'DISPLAY', 'WAYLAND_DISPLAY',
    // Windows
    'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR',
    'ProgramFiles', 'ProgramFiles(x86)', 'ComSpec'
  ])
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (ALLOWED.has(k) && v !== undefined) out[k] = v
  }
  return out
}

function spawnVisibleApp(): void {
  const args = app.isPackaged ? [] : [app.getAppPath()]
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: buildVisibleAppEnv()
  })
  if (!child.pid) { child.unref(); return }
  const entry: TrackedSpawn = {
    pid: child.pid,
    spawnedAt: Date.now(),
    mustKillOnShutdown: true
  }
  trackedSpawns.add(entry)
  child.once('exit', () => { trackedSpawns.delete(entry) })
  child.unref()
}

function releaseTrackedSpawns(): void {
  for (const entry of trackedSpawns) entry.mustKillOnShutdown = false
}

function killOwnedSpawns(): void {
  for (const entry of trackedSpawns) {
    if (!entry.mustKillOnShutdown) continue
    if (process.platform === 'win32') {
      try { process.kill(entry.pid, 'SIGTERM') } catch { /* ignorar */ }
    } else {
      try { process.kill(-entry.pid, 'SIGTERM') } catch { /* ignorar */ }
      try { process.kill(entry.pid, 'SIGTERM') } catch { /* ignorar */ }
    }
  }
}

async function connectBroker(token: string): Promise<AgentBrokerClient> {
  const client = new AgentBrokerClient({
    endpoint: getAgentBrokerEndpoint(),
    token,
    clientId: resolveMcpEnv(process.env, MCP_ENV.clientId, MCP_ENV.legacyClientId) || randomUUID(),
    clientName: resolveMcpEnv(process.env, MCP_ENV.clientName, MCP_ENV.legacyClientName) || 'MCP client',
    clientVersion: resolveMcpEnv(process.env, MCP_ENV.clientVersion, MCP_ENV.legacyClientVersion)
  })

  try {
    await client.connect()
    logMcp('broker connected')
    return client
  } catch {
    logMcp('broker unavailable; opening visible app')
    spawnVisibleApp()
  }

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    try {
      await client.connect()
      logMcp('broker connected after visible app launch')
      releaseTrackedSpawns()
      return client
    } catch {
      // wait until visible app starts broker
    }
  }
  throw new Error(`No se pudo conectar con ${MCP_DISPLAY_NAME}. Abre la app y habilita la integración IA.`)
}

export async function runMcpServerMode(): Promise<void> {
  const token = resolveMcpEnv(process.env, MCP_ENV.token, MCP_ENV.legacyToken)
  if (!token) throw new Error(`Falta ${MCP_ENV.token} para autenticar el MCP de ${MCP_DISPLAY_NAME}.`)

  await app.whenReady()

  let broker: AgentBrokerClient | null = null
  let server: McpServer | null = null
  let shuttingDown = false

  const shutdown = async (exitCode: number, reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logMcp(`shutdown requested: ${reason}`)

    // Red de seguridad: si broker.close() o server.close() se cuelgan, salimos igual.
    const forceExitTimer = setTimeout(() => {
      logMcp('force exit after shutdown timeout')
      process.exit(exitCode)
    }, 3000)
    forceExitTimer.unref()

    try {
      try { if (broker) await broker.close() } catch { /* ignorar */ }
      try { if (server) await server.close() } catch { /* ignorar */ }
      killOwnedSpawns()
    } finally {
      app.quit()
    }
  }

  // ── TRIGGERS DEFENSIVOS (antes de cualquier await que pueda dejar
  //    el proceso vivo si el padre se va antes de tiempo) ─────────────
  process.stdin.on('end', () => { void shutdown(0, 'stdin end') })
  process.stdin.on('close', () => { void shutdown(0, 'stdin close') })
  process.stdin.on('error', (err) => {
    void shutdown(1, `stdin error: ${err instanceof Error ? err.message : String(err)}`)
  })

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => { void shutdown(0, sig) })
  }

  // Watchdog de PPID: macOS no tiene PR_SET_PDEATHSIG. 2s es suficiente
  // para no acumular procesos pero no martilla la CPU.
  if (process.platform !== 'win32') {
    const initialPpid = process.ppid
    const ppidWatcher = setInterval(() => {
      const current = process.ppid
      if (current !== initialPpid || current === 1) {
        void shutdown(0, `parent changed: ${initialPpid} -> ${current}`)
      }
    }, 2000)
    ppidWatcher.unref()
  }

  // ── Conexión y registro normales ───────────────────────────────────
  try {
    broker = await connectBroker(token)
    server = new McpServer({ name: MCP_SERVER_NAME, version: app.getVersion() })
    registerTools(server, broker)
    registerResources(server, broker)

    const transport = new StdioServerTransport()
    // Asignamos onclose ANTES del connect para evitar race con el SDK.
    transport.onclose = () => { void shutdown(0, 'transport closed') }
    await server.connect(transport)

    broker.onClose(() => { void shutdown(1, 'broker connection closed') })
    logMcp('stdio server ready')
  } catch (error) {
    void shutdown(1, `setup failed: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}
