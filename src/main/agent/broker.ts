import { StringDecoder } from 'node:string_decoder'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { connect, createServer, Socket, Server } from 'node:net'
import { AgentSession, BrokerHello, BrokerHelloResponse, BrokerProgress, BrokerRequest, BrokerRequestContext, BrokerResponse } from './protocol'

export interface BrokerServerOptions {
  endpoint: string
  getToken: () => string | null
  handleRequest: (
    session: AgentSession,
    request: BrokerRequest,
    emitProgress: (progress: unknown) => void,
    context: BrokerRequestContext
  ) => Promise<unknown>
  onSessionConnected?: (session: AgentSession) => void
  onSessionDisconnected?: (session: AgentSession) => void
}

interface SessionConnection {
  session: AgentSession
  socket: Socket
}

function safeTokenEquals(left: string | null, right: string): boolean {
  if (!left) return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

async function endpointAcceptsConnection(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(endpoint)
    let settled = false

    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.setTimeout(250, () => settle(false))
  })
}

export class AgentBrokerServer {
  private server: Server | null = null
  private readonly sessions = new Map<string, SessionConnection>()

  constructor(private readonly options: BrokerServerOptions) {}

  async start(): Promise<void> {
    if (this.server) return
    if (process.platform !== 'win32' && existsSync(this.options.endpoint)) {
      if (await endpointAcceptsConnection(this.options.endpoint)) {
        throw new Error('Ya existe un broker MCP activo en este endpoint.')
      }
      rmSync(this.options.endpoint, { force: true })
    }

    this.server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolvePromise, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(this.options.endpoint, () => {
        this.server?.off('error', reject)
        resolvePromise()
      })
    })
  }

  async stop(): Promise<void> {
    for (const { socket } of this.sessions.values()) {
      socket.destroy()
    }
    this.sessions.clear()

    if (!this.server) return
    await new Promise<void>((resolvePromise) => this.server?.close(() => resolvePromise()))
    this.server = null
    if (process.platform !== 'win32' && existsSync(this.options.endpoint)) {
      rmSync(this.options.endpoint, { force: true })
    }
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).map(({ session }) => session)
  }

  isRunning(): boolean {
    return Boolean(this.server)
  }

  disconnectAll(): void {
    for (const { socket } of this.sessions.values()) socket.destroy()
    this.sessions.clear()
  }

  private accept(socket: Socket): void {
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    let authenticatedSession: AgentSession | null = null
    const active = new Map<string, AbortController>()
    const send = (payload: BrokerHelloResponse | BrokerResponse | BrokerProgress) => {
      if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(payload)}\n`)
    }
    const dispatch = (session: AgentSession, request: BrokerRequest) => {
      if (active.has(request.id) || active.size >= 32) {
        send({ id: request.id, ok: false, error: 'Demasiadas solicitudes MCP pendientes o identificador duplicado' })
        return
      }
      const controller = new AbortController()
      active.set(request.id, controller)
      // Do not await inside the frame parser: a cancel in the same chunk must
      // be consumed even while the previous request is waiting on SVN.
      void (async () => {
        try {
          const result = await this.options.handleRequest(session, request, (progress) => {
            if (!controller.signal.aborted) send({ type: 'progress', requestId: request.id, progress })
          }, { signal: controller.signal })
          if (!controller.signal.aborted) send({ id: request.id, ok: true, result })
        } catch (error) {
          if (!controller.signal.aborted) send({
            id: request.id, ok: false,
            error: error instanceof Error ? error.message : 'Error interno del broker'
          })
        } finally {
          if (active.get(request.id) === controller) active.delete(request.id)
        }
      })()
    }

    socket.on('data', (chunk) => {
      buffer += decoder.write(chunk)
      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n')
        const raw = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (!raw.trim()) continue
        let message: unknown
        try { message = JSON.parse(raw) }
        catch { socket.destroy(); return }
        if (!message || typeof message !== 'object') { socket.destroy(); return }

        if (!authenticatedSession) {
          const hello = message as BrokerHello
          if (hello.type !== 'hello' || !safeTokenEquals(this.options.getToken(), String(hello.token || ''))) {
            send({ type: 'hello', ok: false, error: 'Token MCP inválido' })
            socket.destroy()
            return
          }
          authenticatedSession = {
            id: randomUUID(), clientId: String(hello.clientId || randomUUID()),
            clientName: String(hello.clientName || 'MCP client'),
            clientVersion: hello.clientVersion ? String(hello.clientVersion) : undefined,
            connectedAt: new Date().toISOString()
          }
          this.sessions.set(authenticatedSession.id, { session: authenticatedSession, socket })
          send({ type: 'hello', ok: true, sessionId: authenticatedSession.id })
          this.options.onSessionConnected?.(authenticatedSession)
          continue
        }
        const frame = message as Record<string, unknown>
        if (frame.type === 'cancel') {
          if (typeof frame.requestId === 'string') active.get(frame.requestId)?.abort()
          continue
        }
        const request = message as BrokerRequest
        if (typeof request.id !== 'string' || !request.id || typeof request.method !== 'string' || !request.method) {
          socket.destroy()
          return
        }
        dispatch(authenticatedSession, request)
      }
    })
    socket.on('error', () => { /* close aborts the work and removes the session */ })
    socket.on('close', () => {
      for (const controller of active.values()) controller.abort()
      active.clear()
      if (!authenticatedSession) return
      this.sessions.delete(authenticatedSession.id)
      this.options.onSessionDisconnected?.(authenticatedSession)
    })
  }
}
