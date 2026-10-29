import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { runSvn } from './svn-runtime'
import { normalizeRelativePath } from './read-contract'
import { readFileBounded, resolvePhysicalRepoTarget } from './path-guard'

const _require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xml2js = _require('xml2js') as any

/** Working-copy actions previously inlined in the main process entry point. */

const MAX_CONFLICT_FILE_BYTES = 5 * 1024 * 1024

function toRepoRelativeArg(relPath: string): string {
  return normalizeRelativePath(relPath) || '.'
}

function getParentRelativePath(relPath: string): string {
  const normalized = normalizeRelativePath(relPath)
  if (!normalized) return ''
  const parent = dirname(normalized).replace(/\\/g, '/')
  return parent === '.' ? '' : normalizeRelativePath(parent)
}

function splitRelativeSegments(relPath: string): string[] {
  return normalizeRelativePath(relPath).split('/').filter(Boolean)
}

export function normalizeSvnRepoPath(input: string): string {
  const normalized = String(input || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '')
  if (!normalized || normalized === '.') return ''
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function getRepoPathFromSvnUrl(url: string): string {
  const safeUrl = String(url || '').trim()
  if (!safeUrl) return ''
  try {
    return normalizeSvnRepoPath(decodeURIComponent(new URL(safeUrl).pathname))
  } catch {
    return normalizeSvnRepoPath(safeUrl)
  }
}

export function getWorkingCopyScopePath(info: { url: string; rootUrl: string }): string {
  const urlPath = getRepoPathFromSvnUrl(info.url)
  const rootPath = getRepoPathFromSvnUrl(info.rootUrl)
  if (!urlPath || !rootPath) return ''
  if (urlPath === rootPath) return ''
  if (!urlPath.startsWith(`${rootPath}/`)) return ''
  return normalizeSvnRepoPath(urlPath.slice(rootPath.length))
}

export function mapRepoPathToWorkingCopyRelativePath(repoScopedPath: string, workingCopyScope: string): string | null {
  const normalizedRepoPath = normalizeSvnRepoPath(repoScopedPath)
  const normalizedScope = normalizeSvnRepoPath(workingCopyScope)
  if (!normalizedRepoPath) return null
  if (!normalizedScope) return normalizeRelativePath(normalizedRepoPath)
  if (normalizedRepoPath === normalizedScope) return ''
  if (!normalizedRepoPath.startsWith(`${normalizedScope}/`)) return null
  return normalizeRelativePath(normalizedRepoPath.slice(normalizedScope.length))
}

async function isVersionedWorkingCopyPath(repoPath: string, relPath: string): Promise<boolean> {
  try {
    await runSvn(['info', '--xml', '--', toRepoRelativeArg(relPath)], { cwd: repoPath, timeoutMs: 10000 })
    return true
  } catch {
    return false
  }
}

async function findNearestVersionedDirectory(repoPath: string, startRelPath: string): Promise<string> {
  let current = normalizeRelativePath(startRelPath)
  while (true) {
    if (await isVersionedWorkingCopyPath(repoPath, current)) return current
    if (!current) break
    current = getParentRelativePath(current)
  }
  throw new Error('No se encontró una carpeta versionada para aplicar la acción')
}

async function resolveUnversionedBranchTarget(repoPath: string, targetRelPath: string): Promise<{
  versionedAncestorRelPath: string
  branchRelPath: string
  branchName: string
}> {
  const normalizedTarget = normalizeRelativePath(targetRelPath)
  if (!normalizedTarget) throw new Error('No se puede aplicar la acción sobre la raíz del repositorio')

  const versionedAncestorRelPath = await findNearestVersionedDirectory(repoPath, getParentRelativePath(normalizedTarget))
  const targetSegments = splitRelativeSegments(normalizedTarget)
  const ancestorSegments = splitRelativeSegments(versionedAncestorRelPath)
  const branchName = targetSegments[ancestorSegments.length]
  if (!branchName) throw new Error('No se pudo determinar la rama/carpeta a procesar')

  const branchRelPath = normalizeRelativePath(
    ancestorSegments.length > 0 ? `${ancestorSegments.join('/')}/${branchName}` : branchName
  )
  return { versionedAncestorRelPath, branchRelPath, branchName }
}

async function readIgnorePatterns(repoPath: string, dirRelPath: string): Promise<string[]> {
  try {
    const { stdout } = await runSvn(['propget', 'svn:ignore', '--', toRepoRelativeArg(dirRelPath)], {
      cwd: repoPath,
      timeoutMs: 10000
    })
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

async function appendIgnorePattern(repoPath: string, dirRelPath: string, pattern: string): Promise<{
  alreadyPresent: boolean
  propertyTarget: string
}> {
  const nextPattern = String(pattern || '').trim()
  if (!nextPattern) throw new Error('El patrón a ignorar es requerido')

  const propertyTarget = normalizeRelativePath(dirRelPath)
  const existingPatterns = await readIgnorePatterns(repoPath, propertyTarget)
  if (existingPatterns.includes(nextPattern)) {
    return { alreadyPresent: true, propertyTarget: propertyTarget || '.' }
  }

  const updatedValue = [...existingPatterns, nextPattern].join('\n')
  await runSvn(['propset', 'svn:ignore', updatedValue, '--', toRepoRelativeArg(propertyTarget)], {
    cwd: repoPath,
    timeoutMs: 10000
  })
  return { alreadyPresent: false, propertyTarget: propertyTarget || '.' }
}

export async function addPath(repoPath: string, filePath: string, scope: 'item' | 'branch' = 'item') {
  const safeScope = scope === 'branch' ? 'branch' : 'item'
  const target = resolvePhysicalRepoTarget(repoPath, filePath, { allowSymlinkLeaf: true, mustExist: true })
  const normalizedTarget = normalizeRelativePath(target.relativePath)
  const targetToAdd = safeScope === 'branch'
    ? (await resolveUnversionedBranchTarget(repoPath, normalizedTarget)).branchRelPath
    : normalizedTarget

  await runSvn(['add', '--force', '--parents', '--', toRepoRelativeArg(targetToAdd)], {
    cwd: repoPath,
    timeoutMs: 60_000
  })
  return { success: true, scope: safeScope, target: targetToAdd }
}

export async function ignorePath(repoPath: string, filePath: string, scope: 'item' | 'branch' = 'item') {
  const safeScope = scope === 'branch' ? 'branch' : 'item'
  const target = resolvePhysicalRepoTarget(repoPath, filePath, { allowSymlinkLeaf: true, mustExist: true })
  const normalizedTarget = normalizeRelativePath(target.relativePath)
  if (!normalizedTarget) throw new Error('No se puede ignorar la raíz del repositorio')

  let propertyDirRelPath = ''
  let ignorePattern = ''
  if (safeScope === 'branch') {
    const branchTarget = await resolveUnversionedBranchTarget(repoPath, normalizedTarget)
    propertyDirRelPath = branchTarget.versionedAncestorRelPath
    ignorePattern = branchTarget.branchName
  } else {
    const directParentRelPath = getParentRelativePath(normalizedTarget)
    const versionedParentRelPath = await findNearestVersionedDirectory(repoPath, directParentRelPath)
    if (normalizeRelativePath(versionedParentRelPath) !== normalizeRelativePath(directParentRelPath)) {
      throw new Error('Para ignorar solo este elemento, la carpeta padre debe estar versionada. Usa la opción de ignorar la rama completa.')
    }
    propertyDirRelPath = versionedParentRelPath
    ignorePattern = basename(normalizedTarget)
  }

  const result = await appendIgnorePattern(repoPath, propertyDirRelPath, ignorePattern)
  return {
    success: true,
    scope: safeScope,
    ignoredName: ignorePattern,
    propertyTarget: result.propertyTarget,
    alreadyPresent: result.alreadyPresent
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readConflictFile(repoPath: string, absolutePath: string): string {
  try {
    // Each auxiliary file is validated physically (it could be a symlink too).
    const physical = resolvePhysicalRepoTarget(repoPath, absolutePath)
    if (!physical.exists || !statSync(physical.targetReal).isFile()) return ''
    return readFileBounded(physical.targetReal, MAX_CONFLICT_FILE_BYTES).buffer.toString('utf-8')
  } catch {
    return ''
  }
}

export function getConflictContent(repoPath: string, filePath: string) {
  const target = resolvePhysicalRepoTarget(repoPath, filePath, { allowSymlinkLeaf: true })
  const dirPath = dirname(target.targetAbs)
  const fileName = basename(target.targetAbs)
  const minePath = join(dirPath, `${fileName}.mine`)
  const revisionPattern = new RegExp(`^${escapeRegExp(fileName)}\\.r(\\d+)$`)

  const revisionFiles = readdirSync(dirPath)
    .map((entry) => {
      const match = entry.match(revisionPattern)
      if (!match) return null
      return { path: join(dirPath, entry), revision: Number.parseInt(match[1], 10) || 0 }
    })
    .filter((x): x is { path: string; revision: number } => x !== null)
    .sort((a, b) => a.revision - b.revision)

  const basePath = revisionFiles[0]?.path || ''
  const theirsPath = revisionFiles[revisionFiles.length - 1]?.path || ''
  const mine = readConflictFile(repoPath, minePath) || readConflictFile(repoPath, target.targetAbs)
  const base = basePath ? readConflictFile(repoPath, basePath) : ''
  const theirs = theirsPath ? readConflictFile(repoPath, theirsPath) : ''

  if (!mine && !base && !theirs) {
    throw new Error('No se encontraron archivos auxiliares de conflicto para ese archivo')
  }
  return { mine, base, theirs }
}

export async function resolveConflict(repoPath: string, filePath: string, accept: string) {
  const safeAccept = String(accept || '').trim()
  if (safeAccept !== 'mine-full' && safeAccept !== 'theirs-full' && safeAccept !== 'working') {
    throw new Error('Resolución no soportada')
  }
  const { relativePath } = resolvePhysicalRepoTarget(repoPath, filePath, { allowSymlinkLeaf: true })
  const { stdout } = await runSvn(['resolve', '--accept', safeAccept, '--', relativePath || '.'], {
    cwd: repoPath,
    timeoutMs: 60_000
  })
  return { success: true, output: stdout }
}

export async function restorePathAtRevision(
  repoPath: string,
  revision: number,
  svnPath: string,
  action: string = 'M'
) {
  const safeAction = String(action || 'M').trim().toUpperCase()
  if (!['A', 'M', 'D', 'R'].includes(safeAction)) throw new Error('Acción de historial no soportada')

  const targetRevision = safeAction === 'D' ? Number(revision) - 1 : Number(revision)
  if (!Number.isInteger(targetRevision) || targetRevision < 1) {
    throw new Error('No existe una revisión anterior disponible para restaurar este elemento')
  }

  const { stdout: infoXml } = await runSvn(['info', '--xml'], { cwd: repoPath, timeoutMs: 15_000 })
  const parsedInfo = await xml2js.parseStringPromise(infoXml, { explicitArray: false })
  const entry = parsedInfo?.info?.entry
  const rootUrl: string = entry?.repository?.root || ''
  const wcUrl: string = entry?.url || ''
  if (!rootUrl || !wcUrl) throw new Error('No se pudo obtener la ubicación SVN de la copia local')

  const workingCopyScope = getWorkingCopyScopePath({ url: wcUrl, rootUrl })
  const repoScopedPath = normalizeSvnRepoPath(svnPath)
  if (/[\u0000-\u001f]/.test(repoScopedPath)) throw new Error('Ruta SVN inválida')
  const relativeTargetPath = mapRepoPathToWorkingCopyRelativePath(repoScopedPath, workingCopyScope)
  if (relativeTargetPath === null) throw new Error('Ese elemento está fuera del alcance de esta copia local')
  if (!relativeTargetPath) throw new Error('No se puede restaurar la raíz completa de la copia local desde esta vista')

  // Peg revision appended explicitly so names containing "@" are handled.
  const restoreUrl = `${rootUrl}${repoScopedPath}@${targetRevision}`
  const { stdout: remoteInfoXml } = await runSvn(['info', '--xml', restoreUrl], { timeoutMs: 15000 })
  const parsedRemoteInfo = await xml2js.parseStringPromise(remoteInfoXml, { explicitArray: false })
  const remoteEntry = parsedRemoteInfo?.info?.entry
  const remoteKind = String(remoteEntry?.$?.kind || '').trim() === 'dir' ? 'dir' : 'file'

  // The destination (and every existing parent) must physically be inside the WC.
  const physical = resolvePhysicalRepoTarget(repoPath, relativeTargetPath)
  mkdirSync(dirname(physical.targetAbs), { recursive: true })
  // Re-check after creating parents.
  const target = resolvePhysicalRepoTarget(repoPath, relativeTargetPath)

  if (existsSync(target.targetAbs)) {
    const stat = statSync(target.targetAbs)
    if (remoteKind === 'dir' && !stat.isDirectory()) {
      throw new Error('La ruta local actual es un archivo y no puede restaurarse como carpeta')
    }
    if (remoteKind === 'file' && stat.isDirectory()) {
      throw new Error('La ruta local actual es una carpeta y no puede restaurarse como archivo')
    }
  }

  await runSvn(['export', '--force', '--', restoreUrl, target.targetAbs], {
    cwd: repoPath,
    timeoutMs: 5 * 60 * 1000
  })

  return { success: true, path: relativeTargetPath, kind: remoteKind, restoredRevision: targetRevision }
}
