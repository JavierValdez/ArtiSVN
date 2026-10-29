import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { fetchWithValidatedRedirects, type UpdateDownloadAsset } from './app-update-source'

/**
 * Verified installer download (no Electron imports, unit-testable).
 *
 * - HTTPS only, every redirect validated against the host allowlist.
 * - Streams into `<target>.download`, hashing on the fly (SHA-512 from
 *   electron-builder metadata, or SHA-256 GitHub digest).
 * - Checks final size against metadata and Content-Length.
 * - Only after verification the temporary file is renamed atomically.
 * - A previously downloaded file is re-hashed before being reported as ready.
 */

export interface ExpectedChecksum {
  algorithm: 'sha512' | 'sha256'
  /** sha512: base64 (electron-builder); sha256: lowercase hex (GitHub digest). */
  value: string
  encoding: 'base64' | 'hex'
}

export function getExpectedChecksum(asset: UpdateDownloadAsset): ExpectedChecksum | null {
  const sha512 = String(asset.sha512 || '').trim()
  if (sha512 && /^[A-Za-z0-9+/]+={0,2}$/.test(sha512)) {
    return { algorithm: 'sha512', value: sha512, encoding: 'base64' }
  }
  const sha256 = String(asset.sha256 || '').trim().toLowerCase()
  if (/^[a-f0-9]{64}$/.test(sha256)) return { algorithm: 'sha256', value: sha256, encoding: 'hex' }
  return null
}

export class UpdateIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateIntegrityError'
  }
}

export async function hashFile(path: string, checksum: ExpectedChecksum): Promise<{ digest: string; size: number }> {
  const hash = createHash(checksum.algorithm)
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += (chunk as Buffer).length
    hash.update(chunk as Buffer)
  }
  return { digest: hash.digest(checksum.encoding), size }
}

export async function verifyExistingDownload(path: string, asset: UpdateDownloadAsset): Promise<boolean> {
  const checksum = getExpectedChecksum(asset)
  if (!checksum) return false
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return false
    if (typeof asset.size === 'number' && asset.size > 0 && stat.size !== asset.size) return false
    const { digest } = await hashFile(path, checksum)
    return digest === checksum.value
  } catch {
    return false
  }
}

export interface VerifiedDownloadOptions {
  asset: UpdateDownloadAsset
  targetPath: string
  allowedHosts: string[]
  fetchImpl?: typeof fetch
  onProgress?: (receivedBytes: number, totalBytes: number) => void
  signal?: AbortSignal
  userAgent?: string
}

export async function downloadVerifiedFile(options: VerifiedDownloadOptions): Promise<void> {
  const checksum = getExpectedChecksum(options.asset)
  if (!checksum) {
    throw new UpdateIntegrityError('La actualización no publica un checksum verificable; no se descargará.')
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const tempPath = `${options.targetPath}.download`
  await fs.rm(tempPath, { force: true })

  try {
    const response = await fetchWithValidatedRedirects(fetchImpl, options.asset.url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': options.userAgent || 'ArtiSVN' },
      signal: options.signal
    }, options.allowedHosts)

    if (!response.ok || !response.body) {
      throw new Error(`La descarga falló con estado ${response.status}.`)
    }

    const headerLength = Number(response.headers.get('content-length') ?? NaN)
    const expectedSize = typeof options.asset.size === 'number' && options.asset.size > 0 ? options.asset.size : null
    if (expectedSize !== null && Number.isFinite(headerLength) && headerLength !== expectedSize) {
      throw new UpdateIntegrityError('El tamaño anunciado por el servidor no coincide con el metadata.')
    }
    const totalBytes = expectedSize ?? (Number.isFinite(headerLength) ? headerLength : 0)

    const hash = createHash(checksum.algorithm)
    let received = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (expectedSize !== null && received > expectedSize) {
          callback(new UpdateIntegrityError('La descarga excede el tamaño esperado.'))
          return
        }
        hash.update(chunk)
        options.onProgress?.(received, totalBytes)
        callback(null, chunk)
      }
    })

    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      meter,
      createWriteStream(tempPath, { flags: 'wx', mode: 0o644 })
    )

    if (expectedSize !== null && received !== expectedSize) {
      throw new UpdateIntegrityError('El instalador descargado está incompleto (tamaño distinto).')
    }
    if (Number.isFinite(headerLength) && received !== headerLength) {
      throw new UpdateIntegrityError('El instalador descargado está incompleto.')
    }
    if (hash.digest(checksum.encoding) !== checksum.value) {
      throw new UpdateIntegrityError('El checksum del instalador no coincide; se descartó la descarga.')
    }

    // Atomic replace within the same directory.
    await fs.rename(tempPath, options.targetPath)
  } catch (error) {
    await fs.rm(tempPath, { force: true })
    throw error
  }
}
