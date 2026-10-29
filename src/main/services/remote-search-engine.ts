import { SearchAbortedError, type SvnSearchDeps } from './remote-search-svn'
import type { ListXmlEntry } from './remote-search-xml'

/**
 * Remote search engine (no Electron imports; SVN access injected).
 *
 * Per search:
 *  1. Pin the revision (explicit, or HEAD via one `svn info`), so every phase
 *     reads the same snapshot and a new commit invalidates cached data.
 *  2. One streaming `svn list --xml --depth infinity URL@REV` (instead of one
 *     `svn list` per folder) and, in parallel, `svn log --limit 500` for comments.
 *  3. Optional content search: one `svn cat` per text file, 8 at a time, with a
 *     reserved byte budget so concurrency cannot overshoot it.
 *
 * A single AbortController (external cancel + real deadline + result cap)
 * kills any in-flight child; the engine only returns after they exited.
 * Complete listings/logs are cached in memory, keyed by credential identity
 * + URL + revision, with TTL and global entry/LRU bounds.
 */

export type SearchStopReason = 'results' | 'dirs' | 'entries' | 'time' | 'bytes' | 'files' | 'cancelled'

export interface SearchLimits {
  maxDirs: number
  maxEntries: number
  maxDurationMs: number
  maxFileBytes: number
  maxTotalBytes: number
  maxContentFiles: number
  /** Max bytes of `svn list --xml` output read. */
  maxListBytes: number
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  maxDirs: 20_000,
  maxEntries: 300_000,
  maxDurationMs: 15 * 60 * 1000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxContentFiles: 50_000,
  maxListBytes: 256 * 1024 * 1024
}

export interface SearchProgress {
  searched: number
  total: number
  listingStats?: { dirs: number; entries: number }
}

export interface RemoteSearchResult {
  path: string
  name: string
  kind: 'dir' | 'file' | 'revision'
  matchType: 'name' | 'content' | 'comment'
  entryUrl: string
  revision?: number
  revisionMessage?: string
}

export interface RemoteSearchResponse {
  results: RemoteSearchResult[]
  searched: number
  total: number
  truncated: boolean
  stopReason?: SearchStopReason
  /** True when anything was skipped (limits, failures, partial reads). */
  incomplete?: boolean
  errorCounts?: { list: number; log: number; content: number }
  warnings?: string[]
  /** Revision actually searched. */
  revision?: number
  /** Listing served from the in-memory cache. */
  cached?: boolean
  contentBytes?: number
  elapsedMs?: number
}

export interface SearchParams {
  /** Validated base URL (no peg). */
  url: string
  query: string
  deepSearch: boolean
  revision?: number
  maxResults?: number
  limits?: Partial<SearchLimits>
  signal?: AbortSignal
  onProgress?: (progress: SearchProgress) => void
  onResult?: (result: RemoteSearchResult) => void
  /** Progress heartbeat while waiting on svn (default 2 s). */
  heartbeatMs?: number
}

const CONTENT_CONCURRENCY = 8
const LOG_LIMIT = 500
const LOG_MAX_BYTES = 20 * 1024 * 1024

export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'psd',
  'jar', 'war', 'ear', 'zip', 'tar', 'gz', 'bz2', '7z', 'rar',
  'class', 'dll', 'so', 'dylib', 'exe', 'obj', 'o', 'a',
  'mp4', 'mp3', 'avi', 'mov', 'mkv', 'wav', 'flac', 'ogg',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'db', 'sqlite', 'bin', 'dat', 'dump',
  'ttf', 'woff', 'woff2', 'eot'
])

// ─── Cache ─────────────────────────────────────────────────────────────────

interface CacheItem<T> { value: T; size: number; bytes: number; expires: number }

export interface SearchCacheOptions {
  ttlMs?: number
  maxListings?: number
  /** Largest listing that may be cached. */
  maxEntriesPerListing?: number
  /** Sum of entries over all cached listings. */
  maxTotalEntries?: number
  maxLogs?: number
  /** Approximate retained UTF-16 strings and entry overhead, independently of node count. */
  maxListingBytes?: number
  maxLogBytes?: number
  now?: () => number
}

export function createSearchCache(options: SearchCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? 2 * 60 * 1000
  const maxListings = options.maxListings ?? 6
  const maxEntriesPerListing = options.maxEntriesPerListing ?? 300_000
  const maxTotalEntries = options.maxTotalEntries ?? 600_000
  const maxLogs = options.maxLogs ?? 16
  const maxListingBytes = options.maxListingBytes ?? 32 * 1024 * 1024
  const maxLogBytes = options.maxLogBytes ?? 8 * 1024 * 1024
  const now = options.now ?? (() => Date.now())
  const listings = new Map<string, CacheItem<ListXmlEntry[]>>()
  const logs = new Map<string, CacheItem<Array<{ revision: number; message: string }>>>()
  let totalEntries = 0
  let listingBytes = 0
  let logBytes = 0

  const getFresh = <T>(map: Map<string, CacheItem<T>>, key: string, onEvict?: (item: CacheItem<T>) => void): T | null => {
    const item = map.get(key)
    if (!item) return null
    map.delete(key)
    if (item.expires <= now()) { onEvict?.(item); return null }
    map.set(key, item) // LRU: most recent last
    return item.value
  }
  const evictListing = (item: CacheItem<ListXmlEntry[]>) => { totalEntries -= item.size; listingBytes -= item.bytes }
  const evictLog = (item: CacheItem<Array<{ revision: number; message: string }>>) => { logBytes -= item.bytes }

  return {
    getListing: (key: string) => getFresh(listings, key, evictListing),
    setListing(key: string, entries: ListXmlEntry[]) {
      const bytes = key.length * 2 + entries.reduce((sum, entry) => sum + 64 + entry.path.length * 2, 0)
      if (entries.length > maxEntriesPerListing || bytes > maxListingBytes) return
      const old = listings.get(key)
      if (old) { listings.delete(key); evictListing(old) }
      listings.set(key, { value: entries, size: entries.length, bytes, expires: now() + ttlMs })
      totalEntries += entries.length
      listingBytes += bytes
      while (listings.size > maxListings || totalEntries > maxTotalEntries || listingBytes > maxListingBytes) {
        const [oldestKey, oldest] = listings.entries().next().value as [string, CacheItem<ListXmlEntry[]>]
        listings.delete(oldestKey)
        evictListing(oldest)
      }
    },
    getLog: (key: string) => getFresh(logs, key, evictLog),
    setLog(key: string, messages: Array<{ revision: number; message: string }>) {
      const bytes = key.length * 2 + messages.reduce((sum, item) => sum + 64 + item.message.length * 2, 0)
      if (bytes > maxLogBytes) return
      const old = logs.get(key)
      if (old) { logs.delete(key); evictLog(old) }
      logs.set(key, { value: messages, size: messages.length, bytes, expires: now() + ttlMs })
      logBytes += bytes
      while (logs.size > maxLogs || logBytes > maxLogBytes) {
        const [oldestKey, oldest] = logs.entries().next().value as [string, CacheItem<Array<{ revision: number; message: string }>>]
        logs.delete(oldestKey)
        evictLog(oldest)
      }
    },
    clear() { listings.clear(); logs.clear(); totalEntries = 0; listingBytes = 0; logBytes = 0 },
    stats: () => ({ listings: listings.size, logs: logs.size, totalEntries, listingBytes, logBytes })
  }
}

export type SearchCache = ReturnType<typeof createSearchCache>

/** Process-wide cache used by the app (memory only, never persisted). */
export const defaultSearchCache = createSearchCache()

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeBase(url: string): string {
  return String(url || '').trim().replace(/\/+$/g, '')
}

/** Rejects empty/`.`/`..` segments and control characters in listed paths. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || /[\u0000-\u001f\u007f]/.test(path)) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** `base/seg1/seg2@rev` with every segment percent-encoded (spaces, @, %, #, accents). */
export function buildEntryPegUrl(base: string, relativePath: string, revision: number): string {
  const encoded = relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `${normalizeBase(base)}/${encoded}@${revision}`
}

// ─── Engine ────────────────────────────────────────────────────────────────

export async function runRemoteSearch(
  params: SearchParams,
  deps: SvnSearchDeps,
  cache: SearchCache = defaultSearchCache
): Promise<RemoteSearchResponse> {
  const startedAt = Date.now()
  const q = String(params.query || '').trim().toLowerCase()
  if (!q) return { results: [], searched: 0, total: 0, truncated: false }

  const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, ...(params.limits || {}) }
  const maxResults = Math.max(1, Math.min(500, params.maxResults ?? 200))
  const baseUrl = normalizeBase(params.url)

  const controller = new AbortController()
  let stopReason: SearchStopReason | undefined
  const setStop = (reason: SearchStopReason) => { if (!stopReason) stopReason = reason }
  /** Stops the whole search: kills every in-flight svn child. */
  const abortAll = (reason: SearchStopReason) => { setStop(reason); controller.abort() }

  const onExternalAbort = () => abortAll('cancelled')
  if (params.signal?.aborted) abortAll('cancelled')
  else params.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const deadline = setTimeout(() => abortAll('time'), Math.max(0, limits.maxDurationMs))

  const errorCounts = { list: 0, log: 0, content: 0 }
  const warnings: string[] = []
  const warn = (message: string) => { if (warnings.length < 20) warnings.push(message) }
  let unsafeEntries = 0
  let contentPartialFiles = 0

  const results: RemoteSearchResult[] = []
  const pushResult = (result: RemoteSearchResult) => {
    if (results.length >= maxResults) { abortAll('results'); return }
    results.push(result)
    params.onResult?.(result)
    if (results.length >= maxResults) abortAll('results')
  }

  let lastProgress: SearchProgress = { searched: 0, total: 0, listingStats: { dirs: 0, entries: 0 } }
  const emit = (progress: SearchProgress) => { lastProgress = progress; params.onProgress?.(progress) }
  const heartbeat = setInterval(() => params.onProgress?.(lastProgress), Math.max(50, params.heartbeatMs ?? 2000))
  heartbeat.unref?.()

  let revision: number | undefined = params.revision
  let cached = false
  let searched = 0
  let total = 0
  let contentBytes = 0

  const finish = (): RemoteSearchResponse => {
    const incomplete = Boolean(stopReason)
      || errorCounts.list + errorCounts.log + errorCounts.content > 0
      || unsafeEntries > 0
      || contentPartialFiles > 0
    return {
      results,
      searched,
      total,
      truncated: incomplete,
      stopReason,
      incomplete,
      errorCounts,
      warnings: warnings.length ? warnings : undefined,
      revision,
      cached,
      contentBytes,
      elapsedMs: Date.now() - startedAt
    }
  }

  try {
    // 1. Pin the revision.
    if (revision === undefined) {
      try {
        revision = await deps.resolveHeadRevision(baseUrl, controller.signal)
      } catch (error) {
        if (error instanceof SearchAbortedError || controller.signal.aborted) return finish()
        throw error // auth / bad URL: not an empty successful search
      }
    }
    if (controller.signal.aborted) return finish()
    const rev = revision
    const identity = deps.identity(baseUrl)
    const cacheKey = `${identity}\n${baseUrl}\n${rev}`
    const basePeg = `${baseUrl}@${rev}`

    // 2a. Comments, in parallel with the listing.
    let logMessages: Array<{ revision: number; message: string }> = []
    const cachedLog = cache.getLog(cacheKey)
    const logTask: Promise<void> = cachedLog
      ? Promise.resolve().then(() => { logMessages = cachedLog })
      : deps.readLogMessages(basePeg, rev, { signal: controller.signal, limit: LOG_LIMIT, maxBytes: LOG_MAX_BYTES })
        .then((messages) => { logMessages = messages; cache.setLog(cacheKey, messages) })
        .catch((error) => {
          if (error instanceof SearchAbortedError || controller.signal.aborted) return
          errorCounts.log += 1
          warn('No se pudieron leer los comentarios del historial')
        })

    // 2b. Listing (cached snapshot or one streaming `svn list --depth infinity`).
    let dirs = 1
    let entriesSeen = 0
    const fileEntries: Array<{ path: string; name: string }> = []
    const nameHits = new Set<string>()
    const keepForCache: ListXmlEntry[] = []
    let cacheable = true

    const processEntry = (entry: ListXmlEntry): boolean => {
      if (controller.signal.aborted) return false
      if (!isSafeRelativePath(entry.path)) { unsafeEntries += 1; cacheable = false; return true }
      if (entriesSeen >= limits.maxEntries) { setStop('entries'); return false }
      entriesSeen += 1
      if (entry.kind === 'dir') {
        dirs += 1
        if (dirs > limits.maxDirs) { setStop('dirs'); return false }
      }
      if (cacheable) {
        keepForCache.push(entry)
        if (keepForCache.length > limits.maxEntries) cacheable = false
      }
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      if (name.toLowerCase().includes(q)) {
        nameHits.add(entry.path)
        pushResult({ path: entry.path, name, kind: entry.kind, matchType: 'name', entryUrl: `${baseUrl}/${entry.path}` })
        if (controller.signal.aborted) return false
      } else if (entry.kind === 'file' && params.deepSearch) {
        fileEntries.push({ path: entry.path, name })
      }
      if (entriesSeen % 500 === 0) emit({ searched: 0, total: 0, listingStats: { dirs, entries: entriesSeen } })
      return true
    }

    let listFailure: Error | null = null
    const cachedListing = cache.getListing(cacheKey)
    if (cachedListing) {
      cached = true
      for (const entry of cachedListing) if (!processEntry(entry)) break
    } else {
      try {
        const listed = await deps.streamList(basePeg, {
          signal: controller.signal,
          maxBytes: limits.maxListBytes,
          onEntry: processEntry
        })
        if (listed.status === 'bytes') setStop('bytes')
        if (listed.status === 'complete' && cacheable && !stopReason && unsafeEntries === 0) {
          cache.setListing(cacheKey, keepForCache)
        }
      } catch (error) {
        if (!(error instanceof SearchAbortedError) && !controller.signal.aborted) {
          errorCounts.list += 1
          listFailure = error as Error
          warn('El listado del repositorio no se completó')
        }
      }
    }
    if (unsafeEntries > 0) warn(`Se omitieron ${unsafeEntries} entradas con rutas no válidas`)
    emit({ searched: 0, total: 0, listingStats: { dirs, entries: entriesSeen } })

    if (listFailure && entriesSeen === 0) {
      controller.abort()
      await logTask
      throw listFailure
    }
    await logTask
    // Comments are reported after names (same order as before), even if the
    // listing was cut by time: they were fetched in parallel.
    for (const entry of logMessages) {
      if (results.length >= maxResults) break
      if (entry.message && entry.message.toLowerCase().includes(q)) {
        pushResult({
          path: entry.message.length > 90 ? `${entry.message.slice(0, 90)}...` : entry.message,
          name: `r${entry.revision}`,
          kind: 'revision',
          matchType: 'comment',
          entryUrl: baseUrl,
          revision: entry.revision,
          revisionMessage: entry.message
        })
      }
    }

    // 3. Content.
    if (!params.deepSearch || stopReason) return finish()
    const targets = fileEntries.filter((entry) => !BINARY_EXTENSIONS.has((entry.name.split('.').pop() || '').toLowerCase()))
    total = Math.min(targets.length, limits.maxContentFiles)
    if (targets.length > limits.maxContentFiles) setStop('files')
    emit({ searched: 0, total })

    let next = 0
    let reserved = 0
    const worker = async () => {
      while (next < total && !controller.signal.aborted) {
        const remaining = limits.maxTotalBytes - reserved
        // Other workers may still release reserved (unread) bytes. Decide
        // exhaustion after all workers finish, rather than reporting a false cap.
        if (remaining <= 0) return
        const entry = targets[next++]
        const budget = Math.min(limits.maxFileBytes, remaining)
        reserved += budget
        try {
          const cat = await deps.catContains(buildEntryPegUrl(baseUrl, entry.path, rev), q, {
            signal: controller.signal,
            maxBytes: budget
          })
          reserved -= budget - cat.bytesRead
          contentBytes += cat.bytesRead
          if (!controller.signal.aborted) {
            searched += 1
            if (cat.match) pushResult({ path: entry.path, name: entry.name, kind: 'file', matchType: 'content', entryUrl: `${baseUrl}/${entry.path}` })
            else if (!cat.complete) contentPartialFiles += 1
          }
        } catch {
          reserved -= budget
          if (!controller.signal.aborted) {
            searched += 1
            errorCounts.content += 1
          }
        }
        emit({ searched, total })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONTENT_CONCURRENCY, total) }, worker))
    if (!stopReason && next < total) setStop('bytes')
    if (errorCounts.content > 0) warn(`No se pudo leer el contenido de ${errorCounts.content} archivo(s)`)
    if (contentPartialFiles > 0) warn(`${contentPartialFiles} archivo(s) solo se revisaron parcialmente por el límite de tamaño`)
    return finish()
  } finally {
    clearTimeout(deadline)
    clearInterval(heartbeat)
    params.signal?.removeEventListener('abort', onExternalAbort)
  }
}
