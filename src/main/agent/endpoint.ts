import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'

// Keep this legacy endpoint stable: previously installed JaviSVN bridges connect here.
// Runtime path must be \\.\pipe\javisvn-agent-broker; over-escaping breaks listen() on Windows.
const BROKER_NAME = 'javisvn-agent-broker'
const MAX_UNIX_SOCKET_PATH_BYTES = 100

export const WINDOWS_AGENT_BROKER_ENDPOINT = String.raw`\\.\pipe\javisvn-agent-broker`

export function resolveAgentBrokerEndpoint(input: {
  platform: NodeJS.Platform
  userDataPath: string
  tempDir?: string
  uid?: number | string
}): string {
  if (input.platform === 'win32') return WINDOWS_AGENT_BROKER_ENDPOINT

  const preferred = posix.join(input.userDataPath, `${BROKER_NAME}.sock`)
  if (Buffer.byteLength(preferred, 'utf-8') <= MAX_UNIX_SOCKET_PATH_BYTES) return preferred

  return posix.join(input.tempDir ?? tmpdir(), `${BROKER_NAME}-${input.uid ?? process.getuid?.() ?? 'u'}.sock`)
}
