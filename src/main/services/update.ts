import { runSvn } from './svn-runtime'
import { buildExternalsNotice, detectSkippedExternals } from './externals'
export { filterSslNoise } from './update-contract'
import { filterSslNoise } from './update-contract'

export interface UpdateLocalRepoOptions {
  onData?: (chunk: string) => void
  onErrorData?: (chunk: string) => void
  signal?: AbortSignal
}

/** `svn update` is stopped only after this long without any output (large SAT updates). */
export const UPDATE_IDLE_TIMEOUT_MS = 15 * 60 * 1000

export interface UpdateLocalRepoResult {
  success: true
  output: string
  /** svn:externals definitions present but not fetched (externals are never fetched automatically). */
  skippedExternalsCount?: number
}

export async function updateLocalRepo(
  repoPath: string,
  options: UpdateLocalRepoOptions = {}
): Promise<UpdateLocalRepoResult> {
  try {
    const { stdout, stderr } = await runSvn(
      ['update'],
      {
        cwd: repoPath,
        idleTimeoutMs: UPDATE_IDLE_TIMEOUT_MS,
        signal: options.signal,
        onData: options.onData,
        onErrorData: (chunk) => {
          const filtered = filterSslNoise(chunk)
          if (filtered.trim()) options.onErrorData?.(filtered)
        }
      }
    )
    const skippedExternalsCount = await detectSkippedExternals(repoPath)
    const notice = buildExternalsNotice(skippedExternalsCount)
    if (notice) options.onData?.(`${notice}\n`)
    return {
      success: true,
      output: notice ? `${stdout || stderr}${notice}\n` : (stdout || stderr),
      ...(skippedExternalsCount > 0 ? { skippedExternalsCount } : {})
    }
  } catch (error) {
    const message = error instanceof Error ? String(error.message || '').trim() : ''
    const interrupted = /no mostró actividad|cancelada|Tiempo de espera/i.test(message)
    throw new Error(
      (message || 'Error al actualizar el repositorio')
      + (interrupted ? '\nLa working copy puede haber quedado bloqueada: usa "Reparar working copy" (svn cleanup) antes de reintentar.' : '')
    )
  }
}
