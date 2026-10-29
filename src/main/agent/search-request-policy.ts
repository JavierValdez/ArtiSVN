/** Keep ordinary searches below common MCP client deadlines. */
export const MCP_SEARCH_DEFAULT_TIMEOUT_MS = 20_000
export const MCP_SEARCH_MAX_TIMEOUT_MS = 45_000
export const MCP_SEARCH_BROKER_GRACE_MS = 5_000

export function mcpSearchTimeoutMs(input: unknown): number {
  if (input === undefined) return MCP_SEARCH_DEFAULT_TIMEOUT_MS
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1000 || input > MCP_SEARCH_MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs debe estar entre 1000 y ${MCP_SEARCH_MAX_TIMEOUT_MS}`)
  }
  return input
}
