import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

export const MAX_TEXT_RESULT_LENGTH = 500_000

export interface TextResult {
  text: string
  truncated: boolean
  originalLength: number
}

export function truncateText(value: string, maxLength = MAX_TEXT_RESULT_LENGTH): TextResult {
  const text = String(value || '')
  if (text.length <= maxLength) {
    return { text, truncated: false, originalLength: text.length }
  }
  return {
    text: `${text.slice(0, maxLength)}\n\n[... contenido truncado ...]`,
    truncated: true,
    originalLength: text.length
  }
}

export function normalizeRepoUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/g, '')
}

export function normalizeRelativePath(input: string): string {
  return String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

export function buildRepoId(repoPath: string): string {
  return createHash('sha256').update(resolve(repoPath)).digest('hex').slice(0, 16)
}

export function resolveRepoRelativeTarget(repoPath: string, filePath: string): {
  repoAbs: string
  targetAbs: string
  relativePath: string
} {
  const repoAbs = resolve(repoPath)
  const targetAbs = resolve(repoPath, filePath)
  const relativePath = relative(repoAbs, targetAbs)

  // Segment-based check: "..foo" is a valid file name, ".." / "../x" escape.
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/)[0] === '..') {
    throw new Error('Ruta fuera del repositorio')
  }

  return { repoAbs, targetAbs, relativePath }
}

export function validateReadOnlyRemoteUrl(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('La URL SVN es requerida')

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('URL SVN inválida')
  }

  const allowedProtocols = new Set(['http:', 'https:', 'svn:', 'svn+ssh:'])
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error('Esquema de URL SVN no permitido')
  }
  if (parsed.username || parsed.password) {
    throw new Error('La URL no debe incluir credenciales')
  }
  return raw
}

export function normalizeRemoteRevision(input: unknown): number | undefined {
  if (input === undefined || input === null || input === '') return undefined
  const revision = Number(input)
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new Error('La revisión debe ser un entero positivo')
  }
  return revision
}

export function buildHistoricalRemoteTarget(input: string, revision?: unknown): {
  safeUrl: string
  targetUrl: string
  revision?: number
  revisionArgs: string[]
} {
  const safeUrl = validateReadOnlyRemoteUrl(input)
  const safeRevision = normalizeRemoteRevision(revision)
  return {
    safeUrl,
    targetUrl: safeRevision ? `${safeUrl}@${safeRevision}` : safeUrl,
    revision: safeRevision,
    revisionArgs: safeRevision ? ['-r', String(safeRevision)] : []
  }
}
