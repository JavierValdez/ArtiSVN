import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { ListXmlScanner, parseLogXmlMessages, type ListXmlEntry } from './remote-search-xml'

/**
 * SVN-backed dependencies for the search engine. The spawner is injected:
 * production passes `spawnSvn` (password on stdin, per-origin credentials and
 * TLS policy, `--non-interactive`); tests pass a plain `svn` spawn.
 *
 * Every call resolves/rejects only after the child process has exited, so a
 * search never returns while one of its svn processes is still alive.
 */

export type SvnSpawner = (args: string[]) => ChildProcessWithoutNullStreams

export class SearchAbortedError extends Error {
  constructor() {
    super('Búsqueda detenida')
    this.name = 'SearchAbortedError'
  }
}

export interface StreamListResult {
  /** complete: svn finished normally; stopped: the consumer asked to stop; bytes: byte cap reached. */
  status: 'complete' | 'stopped' | 'bytes'
  bytes: number
}

export interface CatResult {
  match: boolean
  bytesRead: number
  /** True when the whole file was read (or the needle was found). */
  complete: boolean
}

export interface SvnSearchDeps {
  resolveHeadRevision(url: string, signal: AbortSignal): Promise<number>
  streamList(
    pegUrl: string,
    options: { signal: AbortSignal; maxBytes: number; onEntry: (entry: ListXmlEntry) => boolean | void }
  ): Promise<StreamListResult>
  readLogMessages(
    pegUrl: string,
    revision: number,
    options: { signal: AbortSignal; limit: number; maxBytes: number }
  ): Promise<Array<{ revision: number; message: string }>>
  catContains(pegUrl: string, needle: string, options: { signal: AbortSignal; maxBytes: number }): Promise<CatResult>
  /** Opaque identity of the credentials used for this URL (cache partitioning). Never logged or returned. */
  identity(url: string): string
}

const KILL_GRACE_MS = 1500
const CALL_TIMEOUT_MS = 120_000
const IDLE_TIMEOUT_MS = 60_000

interface ChildRun {
  code: number | null
  stderr: string
  /** We stopped it on purpose (consumer request / cap). */
  stopped: boolean
  aborted: boolean
  timedOut: boolean
}

function runChild(
  spawner: SvnSpawner,
  args: string[],
  options: {
    signal: AbortSignal
    onStdout?: (chunk: Buffer) => boolean | void
  }
): Promise<ChildRun> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal.aborted) {
      resolvePromise({ code: null, stderr: '', stopped: false, aborted: true, timedOut: false })
      return
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawner(args)
    } catch (error) {
      reject(error as Error)
      return
    }
    let exited = false
    let stopped = false
    let aborted = false
    let timedOut = false
    let stderr = ''
    let killTimer: NodeJS.Timeout | undefined

    const kill = () => {
      if (exited) return
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!exited) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
        }, KILL_GRACE_MS)
      }
    }
    const onAbort = () => { aborted = true; kill() }
    options.signal.addEventListener('abort', onAbort, { once: true })
    const hardTimer = setTimeout(() => { timedOut = true; kill() }, CALL_TIMEOUT_MS)
    let idleTimer = setTimeout(() => { timedOut = true; kill() }, IDLE_TIMEOUT_MS)
    const touch = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { timedOut = true; kill() }, IDLE_TIMEOUT_MS)
    }

    child.stdin?.on('error', () => { /* child may exit before reading stdin */ })
    child.stdout.on('data', (chunk: Buffer) => {
      touch()
      if (stopped || aborted) return
      if (options.onStdout?.(chunk) === false) { stopped = true; kill() }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      touch()
      if (stderr.length < 16 * 1024) stderr += chunk.toString()
    })
    const finish = (code: number | null) => {
      if (exited) return
      exited = true
      clearTimeout(hardTimer)
      clearTimeout(idleTimer)
      if (killTimer) clearTimeout(killTimer)
      options.signal.removeEventListener('abort', onAbort)
      resolvePromise({ code, stderr, stopped, aborted, timedOut })
    }
    child.on('close', (code) => finish(code))
    child.on('error', (error) => {
      if (exited) return
      exited = true
      clearTimeout(hardTimer)
      clearTimeout(idleTimer)
      options.signal.removeEventListener('abort', onAbort)
      if (killTimer) clearTimeout(killTimer)
      reject(error)
    })
  })
}

function failure(run: ChildRun, what: string): Error {
  if (run.timedOut) return new Error(`svn ${what}: tiempo de espera agotado`)
  const first = run.stderr.split('\n').map((line) => line.trim()).find(Boolean)
  return new Error(first || `svn ${what} terminó con código ${run.code}`)
}

export function createSvnSearchDeps(spawner: SvnSpawner, identity: (url: string) => string): SvnSearchDeps {
  return {
    identity,

    async resolveHeadRevision(url, signal) {
      let out = ''
      const run = await runChild(spawner, ['info', '--show-item', 'revision', '--no-newline', '--', url], {
        signal,
        onStdout: (chunk) => { if (out.length < 64) out += chunk.toString() }
      })
      if (run.aborted) throw new SearchAbortedError()
      if (run.code !== 0) throw failure(run, 'info')
      const revision = Number.parseInt(out.trim(), 10)
      if (!Number.isInteger(revision) || revision < 0) throw new Error('svn info no devolvió una revisión válida')
      return revision
    },

    async streamList(pegUrl, options) {
      const scanner = new ListXmlScanner()
      const decoder = new StringDecoder('utf8')
      let bytes = 0
      let capped = false
      let parseError: Error | null = null
      const run = await runChild(spawner, ['list', '--xml', '--depth', 'infinity', '--', pegUrl], {
        signal: options.signal,
        onStdout: (chunk) => {
          bytes += chunk.length
          if (bytes > options.maxBytes) { capped = true; return false }
          try {
            for (const entry of scanner.push(decoder.write(chunk))) {
              if (options.onEntry(entry) === false) return false
            }
          } catch (error) {
            parseError = error as Error
            return false
          }
          return undefined
        }
      })
      if (run.aborted) throw new SearchAbortedError()
      if (parseError) throw parseError
      if (capped) return { status: 'bytes', bytes }
      if (run.stopped) return { status: 'stopped', bytes }
      if (run.code !== 0) throw failure(run, 'list')
      scanner.push(decoder.end())
      scanner.end()
      return { status: 'complete', bytes }
    },

    async readLogMessages(pegUrl, revision, options) {
      const chunks: Buffer[] = []
      let bytes = 0
      let capped = false
      const run = await runChild(
        spawner,
        ['log', '--xml', '--limit', String(options.limit), '-r', `${revision}:1`, '--', pegUrl],
        {
          signal: options.signal,
          onStdout: (chunk) => {
            bytes += chunk.length
            if (bytes > options.maxBytes) { capped = true; return false }
            chunks.push(chunk)
            return undefined
          }
        }
      )
      if (run.aborted) throw new SearchAbortedError()
      if (capped) throw new Error('svn log excede el tamaño máximo')
      if (run.code !== 0) throw failure(run, 'log')
      return parseLogXmlMessages(Buffer.concat(chunks).toString('utf-8'))
    },

    async catContains(pegUrl, needle, options) {
      const decoder = new StringDecoder('utf8')
      const query = needle.toLowerCase()
      let window = ''
      let bytesRead = 0
      let match = false
      const run = await runChild(spawner, ['cat', '--', pegUrl], {
        signal: options.signal,
        onStdout: (chunk) => {
          const room = options.maxBytes - bytesRead
          const slice = chunk.length > room ? chunk.subarray(0, Math.max(0, room)) : chunk
          bytesRead += slice.length
          window += decoder.write(slice).toLowerCase()
          if (window.includes(query)) { match = true; return false }
          if (window.length > query.length * 2 + 4096) window = window.slice(-(query.length + 16))
          if (bytesRead >= options.maxBytes) return false
          return undefined
        }
      })
      if (run.aborted) return { match: false, bytesRead, complete: false }
      if (match) return { match: true, bytesRead, complete: true }
      if (run.stopped) return { match: false, bytesRead, complete: false }
      if (run.code !== 0) throw failure(run, 'cat')
      return { match: false, bytesRead, complete: true }
    }
  }
}
