import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connect, createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { AgentBrokerClient } from '../src/main/agent/broker-client'
import { AgentBrokerServer } from '../src/main/agent/broker'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
function endpoint() { return process.platform === 'win32' ? `\\\\.\\pipe\\artisvn-test-${randomUUID()}` : `/tmp/artisvn-${randomUUID()}.sock` }
function client(address: string, id = 'fixture') { return new AgentBrokerClient({ endpoint: address, token: 'test-only', clientId: id, clientName: id }) }
async function outcome(promise: Promise<unknown>, ms = 200) {
  return Promise.race([promise.then(() => 'resolved', () => 'rejected'), delay(ms).then(() => 'pending')])
}
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return true; await delay(5) }
  return predicate()
}

test('closing a broker client rejects its pending request', { timeout: 3000 }, async () => {
  const address = endpoint(), entered = deferred(), release = deferred()
  const server = new AgentBrokerServer({ endpoint: address, getToken: () => 'test-only', handleRequest: async () => { entered.resolve(); await release.promise; return true } })
  await server.start()
  const c = client(address)
  try {
    await c.connect()
    const pending = c.request('remote_search'); void pending.catch(() => {})
    await entered.promise; await c.close()
    assert.equal(await outcome(pending), 'rejected', 'a closed client must not retain a forever-pending search')
  } finally { release.resolve(); await c.close(); await server.stop() }
})

test('aborting one request stops server work and leaves the connection usable', { timeout: 3000 }, async () => {
  const address = endpoint(), entered = deferred(), release = deferred()
  let cancelled = false
  const server = new AgentBrokerServer({ endpoint: address, getToken: () => 'test-only', handleRequest: async (_session, request, _progress, context) => {
    if (request.method === 'ping') return 'pong'
    context?.signal.addEventListener('abort', () => { cancelled = true; release.resolve() }, { once: true })
    entered.resolve(); await release.promise; return true
  } })
  await server.start(); const c = client(address); const controller = new AbortController()
  try {
    await c.connect(); const pending = c.request('remote_search', {}, { signal: controller.signal }); void pending.catch(() => {})
    await entered.promise; controller.abort()
    assert.equal(await eventually(() => cancelled), true, 'cancellation must reach the work in the app')
    assert.equal(await outcome(pending), 'rejected')
    assert.equal(await c.request('ping'), 'pong')
  } finally { release.resolve(); await c.close(); await server.stop() }
})

test('a disconnected socket aborts its active server request', { timeout: 3000 }, async () => {
  const address = endpoint(), entered = deferred(), release = deferred(); let cancelled = false
  const server = new AgentBrokerServer({ endpoint: address, getToken: () => 'test-only', handleRequest: async (_s, _r, _p, context) => {
    context?.signal.addEventListener('abort', () => { cancelled = true; release.resolve() }, { once: true })
    entered.resolve(); await release.promise; return true
  } })
  await server.start(); const c = client(address)
  try {
    await c.connect(); void c.request('remote_search').catch(() => {}); await entered.promise; await c.close()
    assert.equal(await eventually(() => cancelled), true, 'disconnect must terminate remote work')
  } finally { release.resolve(); await c.close(); await server.stop() }
})

test('a request timeout cancels its work without disconnecting other clients', { timeout: 3000 }, async () => {
  const address = endpoint(), release = deferred(); let cancelled = false
  const server = new AgentBrokerServer({ endpoint: address, getToken: () => 'test-only', handleRequest: async (_s, r, _p, context) => {
    if (r.method === 'ping') return 'pong'
    context?.signal.addEventListener('abort', () => { cancelled = true; release.resolve() }, { once: true })
    await release.promise; return true
  } })
  await server.start(); const a = client(address, 'a'), b = client(address, 'b')
  try {
    await Promise.all([a.connect(), b.connect()]); const pending = a.request('remote_search', {}, { timeoutMs: 30 }); void pending.catch(() => {})
    assert.equal(await outcome(pending), 'rejected', 'the request must have a finite deadline')
    assert.equal(await eventually(() => cancelled), true)
    assert.equal(await b.request('ping'), 'pong')
  } finally { release.resolve(); await Promise.all([a.close(), b.close()]); await server.stop() }
})

test('a cancel frame behind a search in the same TCP packet is processed immediately', { timeout: 3000 }, async () => {
  const address = endpoint(), release = deferred(); let cancelled = false
  const server = new AgentBrokerServer({ endpoint: address, getToken: () => 'test-only', handleRequest: async (_s, _r, _p, context) => {
    context?.signal.addEventListener('abort', () => { cancelled = true; release.resolve() }, { once: true })
    await release.promise; return true
  } })
  await server.start(); const socket = connect(address)
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const authenticated = new Promise<void>((resolve) => socket.once('data', () => resolve()))
    socket.write(JSON.stringify({ type: 'hello', token: 'test-only', clientId: 'packet', clientName: 'packet' }) + '\n'); await authenticated
    socket.write(JSON.stringify({ id: 'work', method: 'remote_search' }) + '\n' + JSON.stringify({ type: 'cancel', requestId: 'work' }) + '\n')
    assert.equal(await eventually(() => cancelled), true, 'framing must not block a cancel behind a slow request')
  } finally { release.resolve(); socket.destroy(); await server.stop() }
})


test('a broker that never authenticates cannot leave connect pending forever', { timeout: 3000 }, async () => {
  const address = endpoint()
  const sockets: ReturnType<typeof connect>[] = []
  const server = createServer((socket) => { sockets.push(socket) })
  await new Promise<void>((resolve) => server.listen(address, resolve))
  const c = new AgentBrokerClient({ endpoint: address, token: 'test-only', clientId: 'handshake', clientName: 'handshake', connectTimeoutMs: 30 })
  try {
    assert.equal(await outcome(c.connect()), 'rejected')
  } finally {
    await c.close(); for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
