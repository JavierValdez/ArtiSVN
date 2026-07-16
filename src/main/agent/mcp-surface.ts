import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export interface BrokerRequester {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { onProgress?: (progress: unknown) => void }
  ): Promise<unknown>
}

const remoteTargetShape = {
  remoteId: z.string().optional(),
  url: z.string().optional(),
  revision: z.number().int().positive().optional()
}

function asTextResult(value: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(value, null, 2)
    }]
  }
}

export function registerTools(server: McpServer, broker: BrokerRequester): void {
  server.registerTool('list_remotes', {
    description: 'List configured SVN remotes stored in ArtiSVN.'
  }, async () => asTextResult(await broker.request('list_remotes')))

  server.registerTool('list_local_repos', {
    description: 'List local SVN working copies known to ArtiSVN.'
  }, async () => asTextResult(await broker.request('list_local_repos')))

  server.registerTool('local_status', {
    description: 'Read the working-copy status for a local repository.',
    inputSchema: z.object({ repoId: z.string() })
  }, async ({ repoId }) => asTextResult(await broker.request('local_status', { repoId })))

  server.registerTool('local_diff', {
    description: 'Read a local diff for one file in a working copy.',
    inputSchema: z.object({ repoId: z.string(), filePath: z.string() })
  }, async ({ repoId, filePath }) => asTextResult(await broker.request('local_diff', { repoId, filePath })))

  server.registerTool('local_file_content', {
    description: 'Read local text content for one file in a working copy.',
    inputSchema: z.object({ repoId: z.string(), filePath: z.string() })
  }, async ({ repoId, filePath }) => asTextResult(await broker.request('local_file_content', { repoId, filePath })))

  server.registerTool('local_log', {
    description: 'Read local SVN history for a working copy.',
    inputSchema: z.object({
      repoId: z.string(),
      limit: z.number().int().positive().max(500).optional(),
      fromRevision: z.number().int().positive().optional()
    })
  }, async (args) => asTextResult(await broker.request('local_log', args)))

  server.registerTool('local_blame', {
    description: 'Read line attribution for one local file.',
    inputSchema: z.object({ repoId: z.string(), filePath: z.string() })
  }, async (args) => asTextResult(await broker.request('local_blame', args)))

  server.registerTool('local_revision_file_diff', {
    description: 'Read the diff for a repository path at one revision.',
    inputSchema: z.object({
      repoId: z.string(),
      revision: z.number().int().positive(),
      svnPath: z.string()
    })
  }, async (args) => asTextResult(await broker.request('local_revision_file_diff', args)))

  server.registerTool('local_info', {
    description: 'Read SVN info for a local repository.',
    inputSchema: z.object({ repoId: z.string() })
  }, async (args) => asTextResult(await broker.request('local_info', args)))

  server.registerTool('remote_list', {
    description: 'List entries under a remote SVN URL or configured remote, optionally at one historical revision.',
    inputSchema: z.object(remoteTargetShape).refine((value) => Boolean(value.remoteId || value.url), {
      message: 'remoteId or url is required'
    })
  }, async (args) => asTextResult(await broker.request('remote_list', args)))

  server.registerTool('remote_search', {
    description: 'Search remote SVN entries by name/comment and optionally file content, optionally at one historical revision.',
    inputSchema: z.object({
      ...remoteTargetShape,
      query: z.string(),
      deepSearch: z.boolean().optional(),
      maxResults: z.number().int().positive().max(500).optional()
    }).refine((value) => Boolean(value.remoteId || value.url), {
      message: 'remoteId or url is required'
    })
  }, async (args, extra) => {
    const progressToken = extra._meta?.progressToken
    return asTextResult(await broker.request('remote_search', args, {
      onProgress: progressToken === undefined
        ? undefined
        : (value) => {
          const progress = value as {
            searched?: number
            total?: number
            listingStats?: { dirs: number; entries: number }
          }
          const current = progress.listingStats?.entries ?? progress.searched ?? 0
          const total = progress.total && progress.total > 0 ? progress.total : undefined
          const message = progress.listingStats
            ? `Explorando ${progress.listingStats.entries} entradas en ${progress.listingStats.dirs} carpetas`
            : total
              ? `Buscando en contenido ${progress.searched || 0}/${total}`
              : 'Buscando'
          void extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: current,
              total,
              message
            }
          })
        }
    }))
  })

  server.registerTool('remote_log', {
    description: 'Read remote SVN history, optionally capped at one historical revision.',
    inputSchema: z.object({
      ...remoteTargetShape,
      limit: z.number().int().positive().max(500).optional()
    }).refine((value) => Boolean(value.remoteId || value.url), {
      message: 'remoteId or url is required'
    })
  }, async (args) => asTextResult(await broker.request('remote_log', args)))

  server.registerTool('remote_file_content', {
    description: 'Read remote text file content, optionally at one historical revision.',
    inputSchema: z.object(remoteTargetShape).refine((value) => Boolean(value.remoteId || value.url), {
      message: 'remoteId or url is required'
    })
  }, async (args) => asTextResult(await broker.request('remote_file_content', args)))

  server.registerTool('remote_repo_root', {
    description: 'Read the repository root URL for a remote SVN target, optionally resolving it at one historical revision.',
    inputSchema: z.object(remoteTargetShape).refine((value) => Boolean(value.remoteId || value.url), {
      message: 'remoteId or url is required'
    })
  }, async (args) => asTextResult(await broker.request('remote_repo_root', args)))

  server.registerTool('remote_revision_diff', {
    description: 'Read a remote diff for one repository path at one revision.',
    inputSchema: z.object({
      ...remoteTargetShape,
      svnPath: z.string(),
      revision: z.number().int().positive()
    }).refine((value) => Boolean(value.remoteId || value.url), {
      message: 'remoteId or url is required'
    })
  }, async (args) => asTextResult(await broker.request('remote_revision_diff', args)))

  server.registerTool('remote_info', {
    description: 'Read SVN info for a remote target, optionally at one historical revision.',
    inputSchema: z.object(remoteTargetShape).refine((value) => Boolean(value.remoteId || value.url), {
      message: 'remoteId or url is required'
    })
  }, async (args) => asTextResult(await broker.request('remote_info', args)))

  server.registerTool('checkout_remote', {
    description: 'Create a local working copy under ArtiSVN after visible user confirmation.',
    inputSchema: z.object({
      ...remoteTargetShape,
      targetName: z.string().optional()
    }).refine((value) => Boolean(value.remoteId || value.url), {
      message: 'remoteId or url is required'
    })
  }, async (args) => asTextResult(await broker.request('checkout_remote', args)))

  server.registerTool('update_local_repo', {
    description: 'Update one local working copy after visible user confirmation.',
    inputSchema: z.object({
      repoId: z.string()
    })
  }, async (args) => asTextResult(await broker.request('update_local_repo', args)))
}

function registerResourcesForScheme(
  server: McpServer,
  broker: BrokerRequester,
  scheme: 'artisvn' | 'javisvn',
  nameSuffix = ''
): void {
  server.registerResource(`remotes${nameSuffix}`, `${scheme}://remotes`, {
    title: 'Configured remotes',
    mimeType: 'application/json'
  }, async (uri) => ({
    contents: [{
      uri: uri.toString(),
      mimeType: 'application/json',
      text: JSON.stringify(await broker.request('resource:remotes'), null, 2)
    }]
  }))

  server.registerResource(`repos${nameSuffix}`, `${scheme}://repos`, {
    title: 'Local repositories',
    mimeType: 'application/json'
  }, async (uri) => ({
    contents: [{
      uri: uri.toString(),
      mimeType: 'application/json',
      text: JSON.stringify(await broker.request('resource:repos'), null, 2)
    }]
  }))

  server.registerResource(`repo-status${nameSuffix}`, new ResourceTemplate(`${scheme}://repos/{repoId}/status`, {
    list: async () => {
      const repos = await broker.request('resource:repos') as Array<{ id: string; name: string }>
      return {
        resources: repos.map((repo) => ({
          uri: `${scheme}://repos/${repo.id}/status`,
          name: `${repo.name} status`,
          mimeType: 'application/json'
        }))
      }
    }
  }), {
    title: 'Repository status',
    mimeType: 'application/json'
  }, async (uri, variables) => ({
    contents: [{
      uri: uri.toString(),
      mimeType: 'application/json',
      text: JSON.stringify(
        await broker.request('resource:repo_status', { repoId: String(variables.repoId || '') }),
        null,
        2
      )
    }]
  }))
}

export function registerResources(server: McpServer, broker: BrokerRequester): void {
  registerResourcesForScheme(server, broker, 'artisvn')
  registerResourcesForScheme(server, broker, 'javisvn', '-legacy')
}
