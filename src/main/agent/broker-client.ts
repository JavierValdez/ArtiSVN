import { connect, Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { BrokerHelloResponse, BrokerProgress, BrokerResponse } from './protocol'

export interface BrokerClientOptions {
  endpoint: string
  token: string
  clientId: string
  clientName: string
  clientVersion?: string
}

export class AgentBrokerClient {
  private socket: Socket | null = null
  private connected = false
  private buffer = ''
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    onProgress?: (progress: unknown) => void
  }>()
  private readonly closeListeners = new Set<() => void>()

  constructor(private readonly options: BrokerClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket && this.connected) return
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }

    const socket = connect(this.options.endpoint)
    this.socket = socket
    this.connected = false
    this.buffer = ''

    await new Promise<void>((resolvePromise, reject) => {
      let settled = false
      const cleanupFailedConnect = (error: Error) => {
        if (settled) return
        settled = true
        socket.off('data', onData)
        socket.off('connect', onConnect)
        socket.off('error', onError)
        socket.off('close', onCloseBeforeReady)
        if (this.socket === socket) this.socket = null
        this.connected = false
        reject(error)
      }
      const onError = (error: Error) => cleanupFailedConnect(error)
      const onCloseBeforeReady = () => cleanupFailedConnect(new Error('Conexión con ArtiSVN cerrada antes de autenticar'))
      const onConnect = () => {
        socket.off('error', onError)
        socket.write(`${JSON.stringify({
          type: 'hello',
          token: this.options.token,
          clientId: this.options.clientId,
          clientName: this.options.clientName,
          clientVersion: this.options.clientVersion
        })}\n`)
      }
      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString('utf-8')
        const newlineIndex = this.buffer.indexOf('\n')
        if (newlineIndex < 0) return
        const raw = this.buffer.slice(0, newlineIndex)
        this.buffer = this.buffer.slice(newlineIndex + 1)
        const hello = JSON.parse(raw) as BrokerHelloResponse
        if (!hello.ok) {
          socket.destroy()
          cleanupFailedConnect(new Error(hello.error || 'No se pudo autenticar con ArtiSVN'))
          return
        }

        settled = true
        socket.off('data', onData)
        socket.off('close', onCloseBeforeReady)
        socket.on('data', (nextChunk) => this.handleData(nextChunk))
        socket.on('error', () => {
          // close will perform cleanup and notify listeners
        })
        socket.on('close', () => this.handleClose(socket))
        this.connected = true
        resolvePromise()
      }

      socket.once('error', onError)
      socket.once('connect', onConnect)
      socket.once('close', onCloseBeforeReady)
      socket.on('data', onData)
    })
  }

  async close(): Promise<void> {
    this.socket?.destroy()
    this.socket = null
    this.connected = false
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    options: { onProgress?: (progress: unknown) => void } = {}
  ): Promise<unknown> {
    if (!this.socket) throw new Error('Cliente broker no conectado')
    const id = randomUUID()
    const promise = new Promise<unknown>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject, onProgress: options.onProgress })
    })
    this.socket.write(`${JSON.stringify({ id, method, params })}\n`)
    return promise
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8')
    while (this.buffer.includes('\n')) {
      const newlineIndex = this.buffer.indexOf('\n')
      const raw = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (!raw.trim()) continue
      const message = JSON.parse(raw) as BrokerResponse | BrokerProgress
      if ('type' in message && message.type === 'progress') {
        this.pending.get(message.requestId)?.onProgress?.(message.progress)
        continue
      }
      const response = message as BrokerResponse
      const pending = this.pending.get(response.id)
      if (!pending) continue
      this.pending.delete(response.id)
      if (response.ok) pending.resolve(response.result)
      else pending.reject(new Error(response.error || 'Error del broker'))
    }
  }

  private handleClose(socket: Socket): void {
    if (this.socket !== socket) return
    for (const pending of this.pending.values()) pending.reject(new Error('Conexión con ArtiSVN cerrada'))
    this.pending.clear()
    this.socket = null
    this.connected = false
    for (const listener of this.closeListeners) listener()
  }
}
