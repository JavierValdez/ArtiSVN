import { normalizeRepoUrl } from './read-contract'

/**
 * Read-only snapshot of a file exactly at a given revision (never HEAD or the
 * working copy). Pure module: SVN access is injected so integration tests can
 * drive the real `svn` CLI against temporary repositories.
 */

/** Max bytes of a historical file returned to the renderer as text. */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

/** Bytes inspected for NUL characters to classify binary content. */
const BINARY_SNIFF_BYTES = 8 * 1024

/** Repository-relative SVN path (`/trunk/a.txt`); rejects control characters and traversal. */
export function normalizeRepoScopedSvnPath(svnPath: string): string {
  const raw = String(svnPath || '').replace(/\\/g, '/').trim()
  if (!raw.startsWith('/')) throw new Error('La ruta SVN debe comenzar con "/"')
  if (/[\u0000-\u001f]/.test(raw)) throw new Error('Ruta SVN inválida')
  const normalized = raw.replace(/\/+/g, '/')
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Ruta SVN inválida')
  }
  return normalized
}

/**
 * `root + /encoded/path@rev`. Each segment is percent-encoded so spaces, `@`,
 * `#`, `%` and non-ASCII names are unambiguous, and the explicit peg revision
 * pins the node to that revision even if it was later renamed or deleted.
 */
export function buildRevisionUrl(rootUrl: string, svnPath: string, revision: number): string {
  if (!Number.isInteger(revision) || revision <= 0) throw new Error('La revisión debe ser un entero positivo')
  const encodedPath = normalizeRepoScopedSvnPath(svnPath)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${normalizeRepoUrl(rootUrl)}${encodedPath}@${revision}`
}

export type RevisionSnapshot =
  | {
    kind: 'text'
    path: string
    revision: number
    text: string
    /** Bytes received (≤ MAX_SNAPSHOT_BYTES). */
    bytes: number
    truncated: boolean
    /** latin1 when the content is not valid UTF-8 (legacy encodings). */
    encoding: 'utf-8' | 'latin1'
  }
  | { kind: 'binary'; path: string; revision: number; bytes: number; truncated: boolean }
  | { kind: 'dir'; path: string; revision: number }

export interface SnapshotDeps {
  /** Node kind at the pegged URL (`svn info --show-item kind`). */
  readKind: (pegUrl: string) => Promise<'file' | 'dir'>
  /** `svn cat pegUrl`, stopping after `maxBytes` (truncated=true if more data existed). */
  readBytes: (pegUrl: string, maxBytes: number) => Promise<{ buffer: Buffer; truncated: boolean }>
}

function decodeUtf8(buffer: Buffer, truncated: boolean): string | null {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  // A truncated buffer may end in the middle of a multi-byte sequence.
  const attempts = truncated ? 4 : 1
  for (let cut = 0; cut < attempts; cut += 1) {
    try {
      return decoder.decode(cut === 0 ? buffer : buffer.subarray(0, buffer.length - cut))
    } catch {
      // try trimming one more trailing byte
    }
  }
  return null
}

export function classifySnapshotBytes(buffer: Buffer, truncated: boolean):
  | { kind: 'binary' }
  | { kind: 'text'; text: string; encoding: 'utf-8' | 'latin1' } {
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: 'binary' }
  const utf8 = decodeUtf8(buffer, truncated)
  if (utf8 !== null) return { kind: 'text', text: utf8, encoding: 'utf-8' }
  return { kind: 'text', text: buffer.toString('latin1'), encoding: 'latin1' }
}

export async function readRevisionSnapshot(
  rootUrl: string,
  svnPath: string,
  revision: number,
  deps: SnapshotDeps,
  maxBytes = MAX_SNAPSHOT_BYTES
): Promise<RevisionSnapshot> {
  const path = normalizeRepoScopedSvnPath(svnPath)
  const pegUrl = buildRevisionUrl(rootUrl, path, revision)
  const kind = await deps.readKind(pegUrl)
  if (kind === 'dir') return { kind: 'dir', path, revision }

  const { buffer, truncated } = await deps.readBytes(pegUrl, maxBytes)
  const classified = classifySnapshotBytes(buffer, truncated)
  if (classified.kind === 'binary') {
    return { kind: 'binary', path, revision, bytes: buffer.length, truncated }
  }
  return {
    kind: 'text',
    path,
    revision,
    text: classified.text,
    bytes: buffer.length,
    truncated,
    encoding: classified.encoding
  }
}
