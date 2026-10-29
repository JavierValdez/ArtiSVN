import { createRequire } from 'node:module'
import { join } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { runSvn } from './svn-runtime'
import { buildExternalsNotice, detectSkippedExternals } from './externals'
import { BASE_REPO_PATH } from './local-paths'
import { buildHistoricalRemoteTarget } from './read-contract'
export {
  deriveCheckoutTargetName,
  getInvalidLocalEntryNameReason,
  getInvalidLocalPathReason,
  sanitizeLocalRepoName
} from './checkout-contract'
import {
  getInvalidLocalPathReason,
  sanitizeLocalRepoName
} from './checkout-contract'

const _require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xml2js = _require('xml2js') as any
const parseStringPromise = xml2js.parseStringPromise

const SVN_UPDATE_BATCH_SIZE = 25

export interface CheckoutRemoteOptions {
  revision?: number
  onData?: (chunk: string) => void
  onErrorData?: (chunk: string) => void
  signal?: AbortSignal
  /** Base directory (tests); defaults to the ArtiSVN repositories folder. */
  basePath?: string
}

/** Large SAT checkouts can take hours: stop only when svn is silent this long. */
export const CHECKOUT_IDLE_TIMEOUT_MS = 15 * 60 * 1000

export interface CheckoutRemoteResult {
  success: true
  path: string
  targetName: string
  skippedInvalidCount?: number
  skippedInvalidPaths?: string[]
  /** svn:externals definitions present but not fetched (externals are never fetched automatically). */
  skippedExternalsCount?: number
}

interface RemoteListEntry {
  relativePath: string
  kind: 'dir' | 'file'
}

interface SparseCheckoutPlan {
  dirs: string[]
  files: string[]
  skippedInvalidCount: number
  skippedInvalidPaths: string[]
}

async function parseXml(xml: string): Promise<any> {
  return parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: false
  })
}

function getXmlText(value: any): string {
  if (typeof value === 'string') return value
  if (value && typeof value._ === 'string') return value._
  return ''
}

function isInvalidFilenameCheckoutError(message: string): boolean {
  return (
    /E155000/i.test(message) && /not valid as (?:a )?filename/i.test(message)
  ) || /E720123/i.test(message)
}

function pathDepth(relativePath: string): number {
  return relativePath.split('/').filter(Boolean).length
}

function hasSkippedAncestor(relativePath: string, skippedDirs: Set<string>): boolean {
  const parts = relativePath.split('/').filter(Boolean)
  for (let i = 1; i < parts.length; i += 1) {
    if (skippedDirs.has(parts.slice(0, i).join('/'))) return true
  }
  return false
}

function toLocalPath(targetPath: string, relativePath: string): string {
  return join(targetPath, ...relativePath.split('/').filter(Boolean))
}

function removeCheckoutTarget(targetPath: string): void {
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true, maxRetries: 3 })
  }
}

function svnLongRunOptions(options: CheckoutRemoteOptions) {
  return {
    idleTimeoutMs: CHECKOUT_IDLE_TIMEOUT_MS,
    signal: options.signal,
    onData: options.onData,
    onErrorData: options.onErrorData
  }
}

function emitProgress(
  options: Pick<CheckoutRemoteOptions, 'onData'>,
  message: string
): void {
  options.onData?.(`${message}\n`)
}

function normalizeRemoteListEntries(parsed: any): RemoteListEntry[] {
  const rawLists = parsed.lists?.list
  const lists = Array.isArray(rawLists) ? rawLists : rawLists ? [rawLists] : []
  const result: RemoteListEntry[] = []

  for (const list of lists) {
    const rawEntries = list.entry
    const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : []
    for (const entry of entries) {
      const rawName = getXmlText(entry.name).replace(/\/$/, '')
      if (!rawName) continue
      result.push({
        relativePath: rawName,
        kind: entry.$?.kind === 'dir' ? 'dir' : 'file'
      })
    }
  }

  return result
}

function buildSparseCheckoutPlan(entries: RemoteListEntry[]): SparseCheckoutPlan {
  const skippedDirs = new Set<string>()
  const skippedInvalidPaths: string[] = []
  let skippedInvalidCount = 0
  const dirs: string[] = []
  const files: string[] = []

  const recordSkipped = (relativePath: string, reason: string) => {
    skippedInvalidCount += 1
    if (skippedInvalidPaths.length < 50) {
      skippedInvalidPaths.push(`${relativePath} (${reason})`)
    }
  }

  for (const entry of entries.sort((a, b) => pathDepth(a.relativePath) - pathDepth(b.relativePath))) {
    if (hasSkippedAncestor(entry.relativePath, skippedDirs)) {
      recordSkipped(entry.relativePath, 'directorio padre omitido')
      continue
    }

    const invalidReason = getInvalidLocalPathReason(entry.relativePath)
    if (invalidReason) {
      recordSkipped(entry.relativePath, invalidReason)
      if (entry.kind === 'dir') skippedDirs.add(entry.relativePath)
      continue
    }

    if (entry.kind === 'dir') dirs.push(entry.relativePath)
    else files.push(entry.relativePath)
  }

  return { dirs, files, skippedInvalidCount, skippedInvalidPaths }
}

async function runSvnUpdateBatches(
  argsBeforeTargets: string[],
  targets: string[],
  options: CheckoutRemoteOptions
): Promise<void> {
  for (let i = 0; i < targets.length; i += SVN_UPDATE_BATCH_SIZE) {
    const batch = targets.slice(i, i + SVN_UPDATE_BATCH_SIZE)
    await runSvn(['update', ...argsBeforeTargets, '--', ...batch], svnLongRunOptions(options))
  }
}

async function sparseCheckoutRemoteToLocalRepo(
  target: ReturnType<typeof buildHistoricalRemoteTarget>,
  targetPath: string,
  safeTargetName: string,
  options: CheckoutRemoteOptions
): Promise<CheckoutRemoteResult> {
  emitProgress(options, 'El checkout normal falló por nombres de archivo no válidos. Reintentando en modo compatible...')

  await runSvn(
    ['checkout', '--depth', 'empty', ...target.revisionArgs, '--', target.targetUrl, targetPath],
    svnLongRunOptions(options)
  )

  const { stdout } = await runSvn(
    ['list', '--xml', '--recursive', ...target.revisionArgs, target.targetUrl],
    { idleTimeoutMs: CHECKOUT_IDLE_TIMEOUT_MS, signal: options.signal }
  )
  const plan = buildSparseCheckoutPlan(normalizeRemoteListEntries(await parseXml(stdout)))

  if (plan.skippedInvalidCount > 0) {
    emitProgress(
      options,
      `Se omitirán ${plan.skippedInvalidCount} entradas con nombres no válidos para este sistema.`
    )
  }

  const fileTargets = plan.files.map((relativePath) => toLocalPath(targetPath, relativePath))

  if (plan.dirs.length > 0) {
    emitProgress(options, `Preparando ${plan.dirs.length} carpetas...`)
    const maxDepth = plan.dirs.reduce((max, relativePath) => Math.max(max, pathDepth(relativePath)), 0)
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const depthTargets = plan.dirs
        .filter((relativePath) => pathDepth(relativePath) === depth)
        .map((relativePath) => toLocalPath(targetPath, relativePath))
      await runSvnUpdateBatches(['--depth', 'empty', ...target.revisionArgs], depthTargets, options)
    }
  }

  if (fileTargets.length > 0) {
    emitProgress(options, `Descargando ${fileTargets.length} archivos válidos...`)
    await runSvnUpdateBatches([...target.revisionArgs], fileTargets, options)
  }

  return {
    success: true,
    path: targetPath,
    targetName: safeTargetName,
    skippedInvalidCount: plan.skippedInvalidCount,
    skippedInvalidPaths: plan.skippedInvalidPaths
  }
}

export async function checkoutRemoteToLocalRepo(
  url: string,
  targetName: string,
  options: CheckoutRemoteOptions = {}
): Promise<CheckoutRemoteResult> {
  const target = buildHistoricalRemoteTarget(url, options.revision)
  const safeTargetName = sanitizeLocalRepoName(targetName)
  const basePath = options.basePath ?? BASE_REPO_PATH
  const targetPath = join(basePath, safeTargetName)

  if (existsSync(targetPath)) {
    throw new Error(`Ya existe un directorio con el nombre "${safeTargetName}"`)
  }

  // Create the destination ourselves (fails if it appeared meanwhile). Only a
  // directory created by this operation is ever removed on failure.
  mkdirSync(basePath, { recursive: true })
  try {
    mkdirSync(targetPath)
  } catch {
    throw new Error(`Ya existe un directorio con el nombre "${safeTargetName}"`)
  }

  /** Returns true when the directory created by this operation was removed. */
  const cleanupCreatedTarget = (): boolean => {
    try {
      removeCheckoutTarget(targetPath)
      return !existsSync(targetPath)
    } catch {
      return false
    }
  }

  const withExternalsNotice = async (result: CheckoutRemoteResult): Promise<CheckoutRemoteResult> => {
    const skippedExternalsCount = await detectSkippedExternals(targetPath)
    const notice = buildExternalsNotice(skippedExternalsCount)
    if (notice) emitProgress(options, notice)
    return skippedExternalsCount > 0 ? { ...result, skippedExternalsCount } : result
  }

  try {
    await runSvn(
      ['checkout', ...target.revisionArgs, '--', target.targetUrl, targetPath],
      svnLongRunOptions(options)
    )
    return await withExternalsNotice({ success: true, path: targetPath, targetName: safeTargetName })
  } catch (error) {
    const message = error instanceof Error ? String(error.message || '').trim() : ''
    if (isInvalidFilenameCheckoutError(message) && !options.signal?.aborted) {
      cleanupCreatedTarget()
      try {
        mkdirSync(targetPath)
        return await withExternalsNotice(await sparseCheckoutRemoteToLocalRepo(target, targetPath, safeTargetName, options))
      } catch (fallbackError) {
        cleanupCreatedTarget()
        const fallbackMessage = fallbackError instanceof Error ? String(fallbackError.message || '').trim() : ''
        throw new Error(fallbackMessage || message || 'Error al descargar el repositorio')
      }
    }
    const removed = cleanupCreatedTarget()
    throw new Error(
      `${message || 'Error al descargar el repositorio'}\n` +
      (removed
        ? '(Se eliminó la copia parcial creada por esta descarga.)'
        : `(No se pudo eliminar la copia parcial en "${safeTargetName}"; bórrala manualmente antes de reintentar.)`)
    )
  }
}
