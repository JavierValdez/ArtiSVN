import { connect, Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { BrokerHelloResponse, BrokerProgress, BrokerResponse } from './protocol'

export interface BrokerClientOptions {
  endpoint: string
  token: string
  clientId: string
  clientName: string
  clientVersion?: string
  connectTimeoutMs?: number
}

export interface BrokerRequestOptions {
  onProgress?: (progress: unknown) => void
  signal?: AbortSignal
  timeoutMs?: number
}

function cancelledError(): Error {
  const error = new Error('Solicitud MCP cancelada')
  error.name = 'AbortError'
  return error
}

export class AgentBrokerClient {
  private socket: Socket | null = null
  private connected = false
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    cleanup: () => void
    onProgress?: (progress: unknown) => void
  }>()
  private readonly closeListeners = new Set<() => void>()

  constructor(private readonly options: BrokerClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket && this.connected) return
    if (this.socket) this.socket.destroy()

    const socket = connect(this.options.endpoint)
    this.socket = socket
    this.connected = false
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')

    await new Promise<void>((resolvePromise, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanupFailedConnect = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('connect', onConnect)
        socket.off('error', onError)
        socket.off('close', onCloseBeforeReady)
        if (this.socket === socket) this.socket = null
        this.connected = false
        socket.destroy()
        reject(error)
      }
      const onError = (error: Error) => cleanupFailedConnect(error)
      const onCloseBeforeReady = () => cleanupFailedConnect(new Error('Conexión con ArtiSVN cerrada antes de autenticar'))
      const onConnect = () => {
        socket.write(`${JSON.stringify({
          type: 'hello',
          token: this.options.token,
          clientId: this.options.clientId,
          clientName: this.options.clientName,
          clientVersion: this.options.clientVersion
        })}\n`)
      }
      const onData = (chunk: Buffer) => {
        this.buffer += this.decoder.write(chunk)
        const newlineIndex = this.buffer.indexOf('\n')
        if (newlineIndex < 0) return
        const raw = this.buffer.slice(0, newlineIndex)
        this.buffer = this.buffer.slice(newlineIndex + 1)
        let hello: BrokerHelloResponse
        try { hello = JSON.parse(raw) as BrokerHelloResponse }
        catch { cleanupFailedConnect(new Error('Respuesta de autenticación del broker inválida')); return }
        if (!hello.ok) {
          cleanupFailedConnect(new Error(hello.error || 'No se pudo autenticar con ArtiSVN'))
          return
        }

        settled = true
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onCloseBeforeReady)
        socket.on('data', (nextChunk) => this.handleData(nextChunk))
        socket.on('error', () => { /* close performs cleanup */ })
        socket.on('close', () => this.handleClose(socket))
        this.connected = true
        resolvePromise()
        this.handleData(Buffer.alloc(0))
      }

      timer = setTimeout(() => cleanupFailedConnect(new Error('Tiempo de espera agotado al conectar con ArtiSVN')), this.options.connectTimeoutMs ?? 10_000)
      timer.unref()
      socket.once('error', onError)
      socket.once('connect', onConnect)
      socket.once('close', onCloseBeforeReady)
      socket.on('data', onData)
    })
  }

  async close(): Promise<void> {
    const socket = this.socket
    if (!socket) return
    // Reject before clearing the socket; the asynchronous close event would
    // otherwise fail its identity check and leave every request pending.
    this.handleClose(socket)
    socket.destroy()
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async request(method: string, params?: Record<string, unknown>, options: BrokerRequestOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) throw cancelledError()
    const socket = this.socket
    if (!socket || !this.connected || socket.destroyed) throw new Error('Cliente broker no conectado')
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error('Plazo del broker inválido')
    }
    const id = randomUUID()
    return new Promise<unknown>((resolvePromise, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cancel = (error: Error) => {
        if (!this.pending.has(id)) return
        if (!socket.destroyed) socket.write(`${JSON.stringify({ type: 'cancel', requestId: id })}\n`)
        this.finish(id, error)
      }
      const onAbort = () => cancel(cancelledError())
      this.pending.set(id, {
        resolve: resolvePromise,
        reject,
        onProgress: options.onProgress,
        cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort) }
      })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) { onAbort(); return }
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => cancel(new Error('Tiempo de espera de la solicitud MCP agotado')), options.timeoutMs)
        timer.unref()
      }
      socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.finish(id, error)
      })
    })
  }

  private finish(id: string, error?: Error, value?: unknown): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    if (error) pending.reject(error)
    else pending.resolve(value)
  }

  private handleData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    while (this.buffer.includes('\n')) {
      const newlineIndex = this.buffer.indexOf('\n')
      const raw = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (!raw.trim()) continue
      let message: BrokerResponse | BrokerProgress
      try { message = JSON.parse(raw) as BrokerResponse | BrokerProgress }
      catch { this.socket?.destroy(); return }
      if ('type' in message && message.type === 'progress') {
        this.pending.get(message.requestId)?.onProgress?.(message.progress)
        continue
      }
      const response = message as BrokerResponse
      this.finish(response.id, response.ok ? undefined : new Error(response.error || 'Error del broker'), response.result)
    }
  }

  private handleClose(socket: Socket): void {
    if (this.socket !== socket) return
    for (const id of [...this.pending.keys()]) this.finish(id, new Error('Conexión con ArtiSVN cerrada'))
    this.socket = null
    this.connected = false
    for (const listener of this.closeListeners) listener()
  }
}
