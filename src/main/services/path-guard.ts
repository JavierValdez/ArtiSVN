import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Physical path isolation for working-copy reads and operations.
 *
 * Lexical checks (`resolve` + `relative`) are not enough: a versioned symlink
 * (svn:special) or a Windows junction inside a working copy can point outside
 * of it. These helpers compare real (physical) paths.
 */

/** Segment-based containment: `..foo` is a valid child name, `..` / `../x` are not. */
export function isLexicallyInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  const first = rel.split(/[\\/]/)[0]
  return first !== '..'
}

export function isStrictlyInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target))
  return rel !== '' && isLexicallyInside(base, target)
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

function lexists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export interface PhysicalTarget {
  /** Lexical absolute path of the repository. */
  repoAbs: string
  /** Physical path of the repository. */
  repoReal: string
  /** Lexical absolute target (inside repoAbs). */
  targetAbs: string
  /**
   * Physical target path. For a symlink leaf with `allowSymlinkLeaf`, this is
   * the physical parent joined with the link name (the link itself, not its target).
   */
  targetReal: string
  /** Lexical relative path from the repository root, using the platform separator. */
  relativePath: string
  exists: boolean
}

export interface PhysicalTargetOptions {
  /** Require the target to exist. */
  mustExist?: boolean
  /**
   * SVN operations (add/commit/revert/diff...) work on the link itself and do not
   * follow it. Reads must keep this false so the link target is checked too.
   */
  allowSymlinkLeaf?: boolean
}

/** Resolves the closest existing ancestor physically and re-appends the missing tail. */
function physicalOfPossiblyMissing(path: string): string | null {
  const tail: string[] = []
  let current = path
  while (!lexists(current)) {
    const parent = dirname(current)
    if (parent === current) return null
    tail.unshift(basename(current))
    current = parent
  }
  const real = realpathOrNull(current)
  if (!real) return null
  return tail.length ? join(real, ...tail) : real
}

export function resolvePhysicalRepoTarget(
  repoPath: string,
  filePath: string,
  options: PhysicalTargetOptions = {}
): PhysicalTarget {
  const repoAbs = resolve(String(repoPath || ''))
  const targetAbs = resolve(repoAbs, String(filePath ?? ''))
  if (!isLexicallyInside(repoAbs, targetAbs)) {
    throw new Error('Ruta fuera del repositorio')
  }

  const repoReal = realpathOrNull(repoAbs)
  if (!repoReal) throw new Error('El repositorio no existe')

  const exists = lexists(targetAbs)
  if (options.mustExist && !exists) throw new Error('El archivo o carpeta no existe')

  let targetReal: string | null
  if (exists && options.allowSymlinkLeaf && lstatSync(targetAbs).isSymbolicLink()) {
    const parentReal = realpathOrNull(dirname(targetAbs))
    targetReal = parentReal ? join(parentReal, basename(targetAbs)) : null
  } else if (exists) {
    targetReal = realpathOrNull(targetAbs)
  } else {
    targetReal = physicalOfPossiblyMissing(targetAbs)
  }

  if (!targetReal || !isLexicallyInside(repoReal, targetReal)) {
    throw new Error('La ruta apunta fuera del repositorio (enlace simbólico o junction)')
  }

  return {
    repoAbs,
    repoReal,
    targetAbs,
    targetReal,
    relativePath: relative(repoAbs, targetAbs),
    exists
  }
}

export interface BoundedRead {
  buffer: Buffer
  /** Size of the file on disk at open time. */
  size: number
  truncated: boolean
}

/**
 * Reads at most `maxBytes` from a physically validated regular file.
 * Uses O_NOFOLLOW where available so a last-moment symlink swap of the
 * resolved path is not followed.
 */
export function readFileBounded(physicalPath: string, maxBytes: number): BoundedRead {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const fd = openSync(physicalPath, constants.O_RDONLY | noFollow)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('No es un archivo regular')
    const toRead = Math.max(0, Math.min(stat.size, maxBytes))
    const buffer = Buffer.alloc(toRead)
    let offset = 0
    while (offset < toRead) {
      const read = readSync(fd, buffer, offset, toRead - offset, offset)
      if (read <= 0) break
      offset += read
    }
    return {
      buffer: offset === toRead ? buffer : buffer.subarray(0, offset),
      size: stat.size,
      truncated: stat.size > maxBytes
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Validates that `repoPath` is a managed working copy: a real (non-symlink)
 * direct child directory of `basePath` that contains `.svn`.
 */
export function assertManagedRepoPath(repoPath: string, basePath: string): string {
  const raw = String(repoPath || '').trim()
  if (!raw) throw new Error('Ruta de repositorio inválida')
  const repoAbs = resolve(raw)
  const baseAbs = resolve(basePath)
  if (dirname(repoAbs) !== baseAbs) {
    throw new Error('Ruta de repositorio fuera del directorio permitido')
  }
  let stat
  try {
    stat = lstatSync(repoAbs)
  } catch {
    throw new Error('El repositorio no existe')
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('La copia local debe ser una carpeta real dentro del directorio de ArtiSVN')
  }
  const baseReal = realpathOrNull(baseAbs)
  const repoReal = realpathOrNull(repoAbs)
  if (!baseReal || !repoReal || dirname(repoReal) !== baseReal) {
    throw new Error('Ruta de repositorio fuera del directorio permitido')
  }
  if (!existsSync(join(repoAbs, '.svn'))) {
    throw new Error('La carpeta no es una working copy SVN')
  }
  return repoAbs
}

/** Accepts a path inside one of the allowed roots, checked physically. */
export function isPhysicallyInsideAny(target: string, roots: string[]): boolean {
  const targetReal = physicalOfPossiblyMissing(resolve(target))
  if (!targetReal) return false
  return roots.some((root) => {
    const rootReal = realpathOrNull(resolve(root))
    return Boolean(rootReal) && isLexicallyInside(rootReal as string, targetReal)
  })
}

export const PATH_SEPARATOR = sep
