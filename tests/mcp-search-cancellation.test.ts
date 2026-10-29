import assert from 'node:assert/strict'
import { test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerTools } from '../src/main/agent/mcp-surface'

test('the real MCP cancellation signal reaches remote search on client timeout', { timeout: 3000 }, async () => {
  let observedSignal: AbortSignal | undefined, cancelled = false
  let release!: () => void
  const hold = new Promise<void>((r) => { release = r })
  const server = new McpServer({ name: 'fixture', version: '1' })
  registerTools(server, { request: async (_method, _params, options) => {
    observedSignal = options?.signal
    observedSignal?.addEventListener('abort', () => { cancelled = true; release() }, { once: true })
    await hold; return { results: [] }
  } })
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st)
  const client = new Client({ name: 'fixture-client', version: '1' }); await client.connect(ct)
  try {
    await assert.rejects(client.callTool({ name: 'remote_search', arguments: { url: 'https://fixture.invalid/svn', query: 'q' } }, undefined, { timeout: 30 }), /timed out/i)
    for (let i = 0; i < 50 && !cancelled; i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(observedSignal, 'the MCP surface must forward extra.signal')
    assert.equal(cancelled, true)
  } finally { release(); await client.close(); await server.close() }
})

test('search progress remains increasing when listing changes to content search', async () => {
  const server = new McpServer({ name: 'progress-fixture', version: '1' })
  registerTools(server, { request: async (_method, _params, options) => {
    options?.onProgress?.({ listingStats: { dirs: 2, entries: 5 } })
    options?.onProgress?.({ searched: 0, total: 3 })
    options?.onProgress?.({ searched: 1, total: 3 })
    return { results: [], searched: 1, total: 3, truncated: false }
  } })
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st)
  const client = new Client({ name: 'progress-client', version: '1' }); await client.connect(ct)
  const values: number[] = []
  try {
    await client.callTool({ name: 'remote_search', arguments: { url: 'https://fixture.invalid/svn', query: 'q' } }, undefined, {
      onprogress: (progress) => { values.push(progress.progress) }
    })
    assert.equal(values.length, 3)
    assert.ok(values.every((v, i) => i === 0 || v > values[i - 1]), `progress went backwards: ${values}`)
  } finally { await client.close(); await server.close() }
})
