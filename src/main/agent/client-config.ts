import { win32 } from 'node:path'

export interface AgentClientLaunchConfig {
  command: string
  args: string[]
}

function quoteCmdArg(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`
}

export function buildAgentClientLaunchConfig(input: {
  platform: NodeJS.Platform
  execPath: string
  launchArgs: string[]
  comSpec?: string
  stdioEnvKey?: string
  // Windows-only: nombre del binario CONSOLE shipeado al lado del execPath
  // (p.ej. "ArtiSvnMcp.exe"). Cuando se pasa, en Windows se invoca este
  // binario en lugar del exe Electron GUI principal. En macOS no se usa.
  mcpBridgeExeName?: string
  // Override para tests: ruta absoluta al binario bridge.
  mcpBridgeExePath?: string
}): AgentClientLaunchConfig {
  if (input.platform === 'darwin') {
    // Preferencia 1: usar el bridge MCP standalone si está disponible
    // (empaquetado dentro de Resources/bridge/ en macOS).
    if (input.mcpBridgeExePath) {
      return {
        command: input.mcpBridgeExePath,
        args: []
      }
    }
    // Fallback: lanzar el binario Electron con env vars.
    return {
      command: '/usr/bin/env',
      args: ['-u', 'ELECTRON_RUN_AS_NODE', input.execPath, ...input.launchArgs]
    }
  }

  if (input.platform === 'win32') {
    // Preferencia 1: usar el bridge MCP standalone (CONSOLE subsystem).
    // Esto evita los dos bugs de Windows del exe Electron GUI:
    //   a) ELECTRON_RUN_AS_NODE heredado del cliente MCP no se puede borrar
    //      desde mcp.json (env "" deja la variable definida-pero-vacia y
    //      Electron la trata como activa).
    //   b) WINDOWS_GUI subsystem no propaga stdin/stdout funcionalmente al
    //      cliente que invoca al binario.
    // El bridge standalone es node SEA con CONSOLE subsystem y reusa el
    // protocolo del broker via named pipe (la app GUI sigue siendo la que
    // expone el broker). El binario GUI principal NO cambia.
    const bridgePath = input.mcpBridgeExePath
      ?? (input.mcpBridgeExeName
        ? win32.join(win32.dirname(input.execPath), input.mcpBridgeExeName)
        : undefined)
    if (bridgePath) {
      return {
        command: bridgePath,
        args: []
      }
    }

    // Preferencia 2 (fallback): lanzar Electron con --mcp-stdio explícito.
    // El argumento mantiene compatibilidad incluso si el entrypoint de una
    // versión instalada todavía no reconoce ARTISVN_MCP_STDIO.
    if (input.stdioEnvKey) {
      return {
        command: input.execPath,
        args: input.launchArgs
      }
    }
    // Legacy: sin stdioEnvKey, usar cmd.exe wrapper con --mcp-stdio.
    const commandLine = [
      'set "ELECTRON_RUN_AS_NODE="',
      '&&',
      quoteCmdArg(input.execPath),
      ...input.launchArgs.map(quoteCmdArg)
    ].join(' ')
    return {
      command: input.comSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine]
    }
  }

  if (input.platform === 'linux') {
    if (input.mcpBridgeExePath) {
      return {
        command: input.mcpBridgeExePath,
        args: []
      }
    }
    return {
      command: input.execPath,
      args: input.launchArgs
    }
  }

  return {
    command: input.execPath,
    args: input.launchArgs
  }
}

export function buildAgentClientEnvironment(token: string): Record<string, string> {
  return {
    ARTISVN_MCP_TOKEN: token,
    ARTISVN_MCP_STDIO: '1',
    ELECTRON_RUN_AS_NODE: ''
  }
}
