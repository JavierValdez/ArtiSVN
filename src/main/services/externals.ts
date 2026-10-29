import { runSvn } from './svn-runtime'
import { countExternalDefinitions } from './externals-contract'

export { buildExternalsNotice, countExternalDefinitions, EXPORT_EXTERNALS_NOTICE } from './externals-contract'

/**
 * Local, offline scan of a working copy (wc.db). Best effort: returns 0 on
 * any failure or timeout so the main operation result is never affected.
 */
export async function detectSkippedExternals(wcPath: string): Promise<number> {
  try {
    const { stdout } = await runSvn(['propget', 'svn:externals', '-R', '--xml', '--', wcPath], {
      skipAuth: true,
      timeoutMs: 30_000,
      maxStdoutBytes: 8 * 1024 * 1024
    })
    return await countExternalDefinitions(stdout)
  } catch {
    return 0
  }
}
