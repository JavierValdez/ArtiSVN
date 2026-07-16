import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerResources, registerTools } from '../src/main/agent/mcp-surface'

test('MCP surface lists tools and resources and serves responses', async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const broker = {
    request: async (
      method: string,
      params?: Record<string, unknown>,
      options?: { onProgress?: (progress: unknown) => void }
    ) => {
      calls.push({ method, params })
      if (method === 'resource:repos') return [{ id: 'repo-1', name: 'Repo 1' }]
      if (method === 'resource:repo_status') return [{ path: 'README.md', status: 'M', repoId: params?.repoId }]
      if (method === 'resource:remotes') return [{ id: 'remote-1', name: 'Remote 1' }]
      if (method === 'list_remotes') return [{ id: 'remote-1', name: 'Remote 1' }]
      if (method === 'remote_search') {
        options?.onProgress?.({ searched: 1, total: 2 })
        return { results: [], searched: 1, total: 2, truncated: false }
      }
      return []
    }
  }

  const server = new McpServer({ name: 'artisvn-test', version: '1.0.0' })
  registerTools(server, broker)
  registerResources(server, broker)

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const tools = await client.listTools()
  assert.ok(tools.tools.some((tool) => tool.name === 'list_remotes'))

  const toolResult = await client.callTool({ name: 'list_remotes', arguments: {} })
  assert.match(JSON.stringify(toolResult), /Remote 1/)

  const invalidToolResult = await client.callTool({ name: 'local_status', arguments: {} })
  assert.equal(invalidToolResult.isError, true)
  assert.match(JSON.stringify(invalidToolResult), /repoId/)

  const progressEvents: unknown[] = []
  await client.callTool(
    { name: 'remote_search', arguments: { remoteId: 'remote-1', query: 'needle', deepSearch: true } },
    undefined,
    { onprogress: (progress) => progressEvents.push(progress) }
  )
  assert.match(JSON.stringify(progressEvents), /Buscando en contenido 1\/2/)

  await client.callTool({
    name: 'remote_list',
    arguments: { url: 'https://svn.example.com/repo/trunk', revision: 441234 }
  })
  assert.deepEqual(
    calls.find((call) => call.method === 'remote_list')?.params,
    { url: 'https://svn.example.com/repo/trunk', revision: 441234 }
  )

  const invalidRevisionResult = await client.callTool({
    name: 'remote_list',
    arguments: { url: 'https://svn.example.com/repo/trunk', revision: 0 }
  })
  assert.equal(invalidRevisionResult.isError, true)
  assert.match(JSON.stringify(invalidRevisionResult), /revision/)

  await client.callTool({
    name: 'checkout_remote',
    arguments: {
      url: 'https://svn.example.com/repo/trunk',
      targetName: 'trunk-local',
      revision: 441234
    }
  })
  assert.deepEqual(
    calls.find((call) => call.method === 'checkout_remote')?.params,
    {
      url: 'https://svn.example.com/repo/trunk',
      targetName: 'trunk-local',
      revision: 441234
    }
  )

  await client.callTool({
    name: 'update_local_repo',
    arguments: { repoId: 'repo-1' }
  })
  assert.deepEqual(
    calls.find((call) => call.method === 'update_local_repo')?.params,
    { repoId: 'repo-1' }
  )

  const resources = await client.listResources()
  assert.ok(resources.resources.some((resource) => resource.uri === 'artisvn://remotes'))
  assert.ok(resources.resources.some((resource) => resource.uri === 'artisvn://repos'))
  assert.ok(resources.resources.some((resource) => resource.uri === 'artisvn://repos/repo-1/status'))
  assert.ok(resources.resources.some((resource) => resource.uri === 'javisvn://remotes'))
  assert.ok(resources.resources.some((resource) => resource.uri === 'javisvn://repos'))
  assert.ok(resources.resources.some((resource) => resource.uri === 'javisvn://repos/repo-1/status'))

  const canonicalResource = await client.readResource({ uri: 'artisvn://repos/repo-1/status' })
  const legacyResource = await client.readResource({ uri: 'javisvn://repos/repo-1/status' })
  assert.match(JSON.stringify(canonicalResource), /README\.md/)
  assert.match(JSON.stringify(legacyResource), /README\.md/)
  assert.ok(calls.some((call) => call.method === 'resource:repo_status'))

  await Promise.all([client.close(), server.close()])
})
