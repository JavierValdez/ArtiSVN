import { randomUUID } from 'node:crypto'

export type AgentActivityKind = 'connect' | 'disconnect' | 'tool' | 'resource'

export interface AgentActivityEntry {
  id: string
  at: string
  kind: AgentActivityKind
  clientId: string
  clientName: string
  action: string
  target?: string
  ok: boolean
  durationMs?: number
  error?: string
}

export interface AgentSession {
  id: string
  clientId: string
  clientName: string
  clientVersion?: string
  connectedAt: string
}

export interface BrokerRequest {
  id: string
  method: string
  params?: Record<string, unknown>
}

/** Cancellation belongs to one authenticated socket, never another client. */
export interface BrokerCancel {
  type: 'cancel'
  requestId: string
}

export interface BrokerRequestContext {
  signal: AbortSignal
}

export interface BrokerResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface BrokerProgress {
  type: 'progress'
  requestId: string
  progress: unknown
}

export interface BrokerHello {
  type: 'hello'
  token: string
  clientId?: string
  clientName?: string
  clientVersion?: string
}

export interface BrokerHelloResponse {
  type: 'hello'
  ok: boolean
  sessionId?: string
  error?: string
}

export function createActivityEntry(
  input: Omit<AgentActivityEntry, 'id' | 'at'>
): AgentActivityEntry {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    ...input
  }
}
