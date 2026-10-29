export interface UpdateDownloadAsset {
  name: string
  url: string
  size: number | null
  /** electron-builder metadata checksum (base64 SHA-512). */
  sha512?: string | null
  /** GitHub asset digest (hex SHA-256), when GitHub provides it. */
  sha256?: string | null
}

export interface LatestReleaseInfo {
  version: string
  name: string
  releaseDate: string | null
  releaseNotes: string | null
  downloadAsset: UpdateDownloadAsset | null
  releasePage: string
  source: 'github' | 'gcs'
}

interface ReleaseMetadata {
  version: string
  releaseDate: string | null
  files: UpdateDownloadAsset[]
}

export interface FetchLatestReleaseOptions {
  currentVersion: string
  platform: NodeJS.Platform
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/JavierValdez/ArtiSVN/releases/latest'
export const DEFAULT_RELEASES_BASE_URL =
  'https://storage.googleapis.com/artictools-releases/artisvn/releases'

const USER_AGENT = 'ArtiSVN'
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5

/**
 * Hosts allowed for update metadata and installer downloads (HTTPS only).
 * GitHub release assets are served from github.com and redirected to its CDN.
 *
 * Limits (documented on purpose): checksums come from the same release channel
 * (GitHub API / GCS metadata). They detect corruption, truncation and stale or
 * swapped files, and HTTPS + this allowlist bind the channel to these hosts, but a
 * compromised release channel could publish matching metadata. Installers are
 * not code-signed yet, so there is no independent publisher authentication; the
 * installation remains manual.
 */
export const DEFAULT_ALLOWED_UPDATE_HOSTS = [
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'storage.googleapis.com'
]

export function getAllowedUpdateHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = new Set(DEFAULT_ALLOWED_UPDATE_HOSTS)
  try {
    const base = new URL(getReleasesBaseUrl(env))
    if (base.protocol === 'https:') hosts.add(base.hostname.toLowerCase())
  } catch {
    // ignore invalid override
  }
  return Array.from(hosts)
}

export function isAllowedUpdateUrl(url: string, allowedHosts: string[]): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    return allowedHosts.includes(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * fetch() that follows redirects manually and validates every hop against the
 * allowlist (HTTPS + host). Rejects downgrades and unexpected CDNs.
 */
export async function fetchWithValidatedRedirects(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  allowedHosts: string[],
  maxRedirects = MAX_REDIRECTS
): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!isAllowedUpdateUrl(current, allowedHosts)) {
      throw new Error(`URL de actualización no permitida: ${safeHostOf(current)}`)
    }
    const response = await fetchImpl(current, { ...init, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('Redirección de actualización sin destino')
      current = new URL(location, current).toString()
      continue
    }
    return response
  }
  throw new Error('Demasiadas redirecciones al descargar la actualización')
}

function safeHostOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return 'URL inválida'
  }
}

export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '')
}

function requireValidReleaseVersion(raw: string, source: string): string {
  const version = normalizeVersion(raw)
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${source} devolvió una versión inválida.`)
  }
  return version
}

function parseVersion(raw: string): { parts: number[]; preRelease: boolean } {
  const normalized = normalizeVersion(raw)
  const [stablePart, pre] = normalized.split('-', 2)
  const parts = stablePart
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .map((value) => (Number.isFinite(value) ? value : 0))
  return { parts, preRelease: Boolean(pre) }
}

export function compareVersions(a: string, b: string): number {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  const max = Math.max(av.parts.length, bv.parts.length)

  for (let index = 0; index < max; index += 1) {
    const ai = av.parts[index] ?? 0
    const bi = bv.parts[index] ?? 0
    if (ai > bi) return 1
    if (ai < bi) return -1
  }

  if (av.preRelease && !bv.preRelease) return -1
  if (!av.preRelease && bv.preRelease) return 1
  return 0
}

export function getReleasesBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.ARTISVN_RELEASES_BASE_URL ||
    env.JAVISVN_RELEASES_BASE_URL ||
    DEFAULT_RELEASES_BASE_URL
  ).replace(/\/+$/, '')
}

function platformExtensions(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['.dmg', '.pkg', '.zip']
  if (platform === 'win32') return ['.exe', '.msi']
  return []
}

export function pickCompatibleAsset(
  assets: UpdateDownloadAsset[],
  platform: NodeJS.Platform
): UpdateDownloadAsset | null {
  for (const extension of platformExtensions(platform)) {
    const match = assets.find((asset) =>
      asset.name.toLowerCase().endsWith(extension.toLowerCase())
    )
    if (match) return match
  }
  return null
}

function parseYamlValue(raw: string): string {
  const value = raw.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function resolveReleaseUrl(value: string, releasesBaseUrl: string): string {
  const assetPath = parseYamlValue(value)
  if (/^[a-z][a-z0-9+.-]*:/i.test(assetPath)) return assetPath
  return `${releasesBaseUrl}/${assetPath.replace(/^\/+/, '')}`
}

function getReleaseAssetName(value: string): string {
  const assetPath = parseYamlValue(value).split('?')[0]
  try {
    const parsed = new URL(assetPath)
    const segments = decodeURIComponent(parsed.pathname).split('/')
    return segments.at(-1) || ''
  } catch {
    const segments = assetPath.split('/')
    return segments.at(-1) || ''
  }
}

export function parseReleaseMetadata(
  raw: string,
  releasesBaseUrl: string
): ReleaseMetadata {
  const versionMatch = raw.match(/^version:\s*(.+)$/m)
  if (!versionMatch) {
    throw new Error('Metadata de actualización inválida: falta version.')
  }

  const releaseDateMatch = raw.match(/^releaseDate:\s*(.+)$/m)
  const files: UpdateDownloadAsset[] = []
  let currentFile: UpdateDownloadAsset | null = null

  for (const line of raw.split(/\r?\n/)) {
    const urlMatch = line.match(/^\s*(?:-\s*)?url:\s*(.+)$/)
    if (urlMatch) {
      const assetPath = parseYamlValue(urlMatch[1])
      currentFile = {
        name: getReleaseAssetName(assetPath),
        url: resolveReleaseUrl(assetPath, releasesBaseUrl),
        size: null
      }
      files.push(currentFile)
      continue
    }

    const sizeMatch = line.match(/^\s*size:\s*(\d+)\s*$/)
    if (sizeMatch && currentFile) currentFile.size = Number(sizeMatch[1])

    const shaMatch = line.match(/^\s+sha512:\s*(.+)$/)
    if (shaMatch && currentFile) currentFile.sha512 = parseYamlValue(shaMatch[1])
  }

  const pathMatch = raw.match(/^path:\s*(.+)$/m)
  if (files.length === 0 && pathMatch) {
    const assetPath = parseYamlValue(pathMatch[1])
    const topSha = raw.match(/^sha512:\s*(.+)$/m)
    files.push({
      name: getReleaseAssetName(assetPath),
      url: resolveReleaseUrl(assetPath, releasesBaseUrl),
      size: null,
      sha512: topSha ? parseYamlValue(topSha[1]) : null
    })
  }

  return {
    version: parseYamlValue(versionMatch[1]),
    releaseDate: releaseDateMatch ? parseYamlValue(releaseDateMatch[1]) : null,
    files
  }
}

function metadataFileName(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'latest-mac.yml'
  if (platform === 'win32') return 'latest.yml'
  return null
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  allowedHosts: string[]
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchWithValidatedRedirects(fetchImpl, url, { ...init, signal: controller.signal }, allowedHosts)
  } finally {
    clearTimeout(timer)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function parseGitHubRelease(payload: unknown, platform: NodeJS.Platform): LatestReleaseInfo {
  if (!isRecord(payload) || typeof payload.tag_name !== 'string' || !payload.tag_name.trim()) {
    throw new Error('Respuesta inválida de GitHub Releases: falta tag_name.')
  }
  if (!Array.isArray(payload.assets)) {
    throw new Error('Respuesta inválida de GitHub Releases: falta assets.')
  }

  const assets: UpdateDownloadAsset[] = payload.assets.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== 'string' ||
      !candidate.name.trim() ||
      typeof candidate.browser_download_url !== 'string' ||
      !/^https:\/\//i.test(candidate.browser_download_url)
    ) {
      return []
    }
    const digest = typeof candidate.digest === 'string' ? candidate.digest.trim() : ''
    const sha256 = /^sha256:[a-f0-9]{64}$/i.test(digest) ? digest.slice(7).toLowerCase() : null
    return [{
      name: candidate.name,
      url: candidate.browser_download_url,
      size: typeof candidate.size === 'number' && Number.isFinite(candidate.size)
        ? candidate.size
        : null,
      sha256
    }]
  })

  const version = requireValidReleaseVersion(payload.tag_name, 'GitHub Releases')
  return {
    version,
    name: optionalString(payload.name) || `ArtiSVN ${version}`,
    releaseDate: optionalString(payload.published_at),
    releaseNotes: optionalString(payload.body),
    downloadAsset: pickCompatibleAsset(assets, platform),
    releasePage: optionalString(payload.html_url) || GITHUB_LATEST_RELEASE_URL,
    source: 'github'
  }
}

async function fetchGitHubRelease(
  fetchImpl: typeof fetch,
  platform: NodeJS.Platform,
  timeoutMs: number,
  allowedHosts: string[]
): Promise<LatestReleaseInfo> {
  const response = await fetchWithTimeout(fetchImpl, GITHUB_LATEST_RELEASE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT
    }
  }, timeoutMs, allowedHosts)

  if (!response.ok) {
    throw new Error(`GitHub Releases respondió con estado ${response.status}.`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('GitHub Releases devolvió JSON inválido.')
  }
  return parseGitHubRelease(payload, platform)
}

async function fetchGcsRelease(
  fetchImpl: typeof fetch,
  platform: NodeJS.Platform,
  releasesBaseUrl: string,
  timeoutMs: number,
  allowedHosts: string[]
): Promise<LatestReleaseInfo> {
  const fileName = metadataFileName(platform)
  if (!fileName) throw new Error('No hay actualizaciones configuradas para esta plataforma.')

  const response = await fetchWithTimeout(fetchImpl, `${releasesBaseUrl}/${fileName}`, {
    headers: {
      Accept: 'text/yaml,text/plain',
      'User-Agent': USER_AGENT
    }
  }, timeoutMs, allowedHosts)

  if (!response.ok) {
    throw new Error(`El bucket de releases respondió con estado ${response.status}.`)
  }

  const metadata = parseReleaseMetadata(await response.text(), releasesBaseUrl)
  const version = requireValidReleaseVersion(metadata.version, 'El bucket de releases')
  return {
    version,
    name: `ArtiSVN ${version}`,
    releaseDate: metadata.releaseDate,
    releaseNotes: null,
    downloadAsset: pickCompatibleAsset(metadata.files, platform),
    releasePage: releasesBaseUrl,
    source: 'gcs'
  }
}

export async function fetchLatestRelease(
  options: FetchLatestReleaseOptions
): Promise<LatestReleaseInfo> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const releasesBaseUrl = getReleasesBaseUrl(options.env)
  const allowedHosts = getAllowedUpdateHosts(options.env)

  try {
    const githubRelease = await fetchGitHubRelease(fetchImpl, options.platform, timeoutMs, allowedHosts)
    const hasUpdate = compareVersions(githubRelease.version, options.currentVersion) > 0

    // A valid no-update response is authoritative even when it has no installer.
    // An installer without a GitHub digest cannot be verified: use GCS metadata (sha512).
    if (!hasUpdate || githubRelease.downloadAsset?.sha256) return githubRelease
  } catch {
    // GitHub transport, timeout and validation failures deliberately use GCS below.
  }

  return fetchGcsRelease(fetchImpl, options.platform, releasesBaseUrl, timeoutMs, allowedHosts)
}
