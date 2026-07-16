export const MCP_SERVER_NAME = 'artisvn'
export const MCP_DISPLAY_NAME = 'ArtiSVN'

export const MCP_ENV = {
  token: 'ARTISVN_MCP_TOKEN',
  legacyToken: 'JAVISVN_MCP_TOKEN',
  debug: 'ARTISVN_MCP_DEBUG',
  legacyDebug: 'JAVISVN_MCP_DEBUG',
  clientId: 'ARTISVN_MCP_CLIENT_ID',
  legacyClientId: 'JAVISVN_MCP_CLIENT_ID',
  clientName: 'ARTISVN_MCP_CLIENT_NAME',
  legacyClientName: 'JAVISVN_MCP_CLIENT_NAME',
  clientVersion: 'ARTISVN_MCP_CLIENT_VERSION',
  legacyClientVersion: 'JAVISVN_MCP_CLIENT_VERSION',
  stdio: 'ARTISVN_MCP_STDIO',
  legacyStdio: 'JAVISVN_MCP_STDIO',
  bridgeVersion: 'ARTISVN_BRIDGE_VERSION',
  legacyBridgeVersion: 'JAVISVN_BRIDGE_VERSION'
} as const

export function resolveMcpEnv(
  env: NodeJS.ProcessEnv,
  canonicalKey: string,
  legacyKey: string
): string | undefined {
  return env[canonicalKey] ?? env[legacyKey]
}
