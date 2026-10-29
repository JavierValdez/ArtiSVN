import { app } from 'electron'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { getCredentialsForOrigin, storeGet, storeSet } from './store'
import {
  buildSvnInvocation,
  collectArgOrigins,
  credentialOriginKey,
  parseSvnOrigin,
  resolveTlsPolicy,
  type SvnCredentials,
  type SvnInvocation,
  type SvnOrigin,
  type SvnTlsMode,
  type SvnTlsPolicy,
  type TlsPolicyOverrides
} from './svn-policy'

export interface RunSvnOptions {
  cwd?: string
  onData?: (chunk: string) => void
  onErrorData?: (chunk: string) => void
  /** Run without credentials or extra flags (local-only commands such as `--version`, `cleanup`). */
  skipAuth?: boolean
  /** Explicit credentials typed by the user (connection test). Still origin/scheme checked. */
  credentials?: SvnCredentials
  /** Hard wall-clock limit. 0/undefined = none. */
  timeoutMs?: number
  /** Kill the process if it produces no output for this long. 0/undefined = none. */
  idleTimeoutMs?: number
  /** Cancels the operation. */
  signal?: AbortSignal
  /** Stop reading (and kill svn) once stdout exceeds this many bytes. */
  maxStdoutBytes?: number
}

export interface RunSvnResult {
  stdout: string
  stderr: string
  /** True when stdout was cut at `maxStdoutBytes`. */
  truncated?: boolean
}

function getDefaultSvnCandidates(): string[] {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    return [
      join(pf, 'TortoiseSVN', 'bin', 'svn.exe'),
      join(pf86, 'TortoiseSVN', 'bin', 'svn.exe'),
      join(pf, 'SlikSvn', 'bin', 'svn.exe'),
      join(pf, 'CollabNet Subversion Client', 'svn.exe'),
      'svn.exe'
    ]
  }

  return [
    '/opt/homebrew/bin/svn',
    '/usr/local/bin/svn',
    '/usr/bin/svn',
    '/opt/local/bin/svn'
  ]
}

function getExtraPathSegments(): string {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    return [join(pf, 'TortoiseSVN', 'bin'), join(pf86, 'TortoiseSVN', 'bin')].join(';')
  }
  return '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
}

export function buildEnvWithExtraPath(): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const extra = getExtraPathSegments()
  const current = process.env[pathKey] || process.env.PATH || ''
  const firstSegment = extra.split(sep)[0] || ''
  const merged = firstSegment && current.includes(firstSegment) ? current : `${extra}${sep}${current}`
  return { ...process.env, [pathKey]: merged, PATH: merged }
}

function canExecuteSvn(bin: string): boolean {
  try {
    const result = spawnSync(bin, ['--version', '--quiet'], {
      env: { ...buildEnvWithExtraPath(), LANG: 'en_US.UTF-8' },
      encoding: 'utf-8',
      timeout: 4000
    })
    if (result.error) return false
    return result.status === 0 && Boolean((result.stdout || '').trim())
  } catch {
    return false
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => Boolean(value && value.trim())))]
}

function findSvnBin(preferred?: string): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const fallback = `svn${ext}`
  const bundledPackaged = join(process.resourcesPath || '', 'bin', `svn${ext}`)
  const bundledDev = join(__dirname, `../../../resources/bin/svn${ext}`)
  const preferredValues = [
    preferred || '',
    process.env.ARTISVN_SVN_BIN || process.env.JAVISVN_SVN_BIN || ''
  ]

  const candidates = app.isPackaged
    ? uniqueStrings([
      ...preferredValues,
      bundledPackaged,
      bundledDev,
      ...getDefaultSvnCandidates(),
      fallback
    ])
    : uniqueStrings([
      ...preferredValues,
      ...getDefaultSvnCandidates(),
      bundledPackaged,
      bundledDev,
      fallback
    ])

  for (const candidate of candidates) {
    if (candidate !== fallback && !existsSync(candidate)) continue
    if (canExecuteSvn(candidate)) return candidate
  }
  return fallback
}

// Resolved lazily: avoids sync spawns and config reads at module import time.
let resolvedSvnBin: string | null = null

function currentSvnBin(): string {
  if (!resolvedSvnBin) resolvedSvnBin = findSvnBin(String(storeGet('svnBinPath') || ''))
  return resolvedSvnBin
}

export function getSvnBin(): string {
  return currentSvnBin()
}

/**
 * Validates and persists an SVN binary override. Only absolute paths to an
 * existing executable named `svn`/`svn.exe` that answers `--version` are accepted,
 * because this binary later receives the SVN password on stdin.
 */
export function setSvnBin(binPath: string): { bin: string; version: string | null } {
  const safePath = String(binPath || '').trim()
  if (!safePath) throw new Error('Ruta de binario SVN inválida')
  if (safePath !== 'svn') {
    const expectedName = process.platform === 'win32' ? /(^|[\\/])svn\.exe$/i : /(^|\/)svn$/
    if (!isAbsolute(safePath) || !expectedName.test(safePath) || !existsSync(safePath)) {
      throw new Error('El binario SVN debe ser una ruta absoluta existente a "svn"')
    }
  }
  const candidate = findSvnBin(safePath === 'svn' ? '' : safePath)
  if (!canExecuteSvn(candidate)) {
    throw new Error('No se pudo ejecutar el binario SVN indicado')
  }
  resolvedSvnBin = candidate
  storeSet('svnBinPath', safePath === 'svn' ? '' : safePath)
  const result = spawnSync(candidate, ['--version', '--quiet'], {
    env: { ...buildEnvWithExtraPath(), LANG: 'en_US.UTF-8' },
    encoding: 'utf-8',
    timeout: 5000
  })
  return { bin: candidate, version: result.status === 0 ? String(result.stdout || '').trim() || null : null }
}

export async function getSvnBinInfo(): Promise<{ bin: string; configured: string | null; version: string | null }> {
  let version: string | null = null
  try {
    const { stdout } = await runSvn(['--version', '--quiet'], { skipAuth: true, timeoutMs: 5000 })
    version = stdout.trim() || null
  } catch {
    version = null
  }

  const configured = String(storeGet('svnBinPath') || '').trim() || null
  return { bin: currentSvnBin(), configured, version }
}

// ─── TLS legacy profile (SAT) ───────────────────────────────────────────────

const LEGACY_OPENSSL_CONF_NAME = 'artisvn-openssl-legacy.cnf'
const LEGACY_OPENSSL_CONF = `openssl_conf = default_conf

[default_conf]
ssl_conf = ssl_sect

[ssl_sect]
system_default = tls_defaults

[tls_defaults]
MinProtocol = TLSv1
CipherString = DEFAULT@SECLEVEL=0
Options = UnsafeLegacyRenegotiation
`

function getLegacyOpenSslConfPath(): string | null {
  try {
    const confPath = join(app.getPath('userData'), LEGACY_OPENSSL_CONF_NAME)
    if (!existsSync(confPath) || readFileSync(confPath, 'utf-8') !== LEGACY_OPENSSL_CONF) {
      writeFileSync(confPath, LEGACY_OPENSSL_CONF, 'utf-8')
    }
    return confPath
  } catch {
    return null
  }
}

/** Optional per-origin overrides stored in config as `svnTlsPolicies: { "https://host:443": "strict" | "legacy-sat" }`. */
function getTlsOverrides(): TlsPolicyOverrides {
  const raw = storeGet<Record<string, unknown>>('svnTlsPolicies')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: TlsPolicyOverrides = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === 'strict' || value === 'legacy-sat') result[key] = value as SvnTlsMode
  }
  return result
}

export function getTlsPolicyForUrl(url: string): SvnTlsPolicy {
  return resolveTlsPolicy(parseSvnOrigin(url), getTlsOverrides())
}

// ─── Origin resolution ──────────────────────────────────────────────────────

const WC_ORIGIN_TTL_MS = 60_000
const wcOriginCache = new Map<string, { origin: SvnOrigin | null; at: number }>()

function runBareSync(args: string[], cwd?: string): string | null {
  try {
    const result = spawnSync(currentSvnBin(), args, {
      cwd,
      env: { ...buildEnvWithExtraPath(), LANG: 'en_US.UTF-8' },
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true
    })
    if (result.error || result.status !== 0) return null
    return String(result.stdout || '')
  } catch {
    return null
  }
}

/**
 * Reads the repository root URL of a working copy from its local metadata
 * (`svn info` on a WC path is offline). Cached briefly.
 */
export function resolveWorkingCopyOrigin(wcPath: string): SvnOrigin | null {
  const key = resolve(wcPath)
  const cached = wcOriginCache.get(key)
  if (cached && Date.now() - cached.at < WC_ORIGIN_TTL_MS) return cached.origin
  const stdout = runBareSync(['info', '--show-item', 'repos-root-url', '--no-newline', key])
  const origin = stdout ? parseSvnOrigin(stdout.trim()) : null
  wcOriginCache.set(key, { origin, at: Date.now() })
  return origin
}

export function invalidateWorkingCopyOrigin(wcPath?: string): void {
  if (!wcPath) wcOriginCache.clear()
  else wcOriginCache.delete(resolve(wcPath))
}

function findLocalPathArg(args: string[], cwd?: string): string | null {
  for (const arg of args) {
    if (!arg || arg.startsWith('-') || parseSvnOrigin(arg)) continue
    const candidate = isAbsolute(arg) ? arg : cwd ? resolve(cwd, arg) : null
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Determines the single remote origin an svn command talks to:
 * URL arguments first, otherwise the working copy (cwd or local path argument).
 */
export function resolveOperationOrigin(args: string[], cwd?: string): SvnOrigin | null {
  const urlOrigins = collectArgOrigins(args)
  if (urlOrigins.length > 0) {
    const keys = new Set(urlOrigins.map(credentialOriginKey))
    if (keys.size > 1) {
      throw new Error('La operación SVN mezcla servidores distintos; no se enviarán credenciales')
    }
    return urlOrigins[0]
  }
  if (cwd && existsSync(cwd)) {
    const origin = resolveWorkingCopyOrigin(cwd)
    if (origin) return origin
  }
  const localPath = findLocalPathArg(args, cwd)
  return localPath ? resolveWorkingCopyOrigin(localPath) : null
}

interface PreparedSvn {
  invocation: SvnInvocation
  env: NodeJS.ProcessEnv
  policy: SvnTlsPolicy
}

export function prepareSvnInvocation(args: string[], options: RunSvnOptions = {}): PreparedSvn {
  const env = { ...buildEnvWithExtraPath(), LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv
  // Deterministic TLS: never inherit an OpenSSL config from the user's shell.
  delete env.OPENSSL_CONF

  if (options.skipAuth) {
    const policy = resolveTlsPolicy(null)
    return {
      invocation: buildSvnInvocation({ args, origin: null, policy, credentials: null, bare: true }),
      env,
      policy
    }
  }

  const origin = resolveOperationOrigin(args, options.cwd)
  const policy = resolveTlsPolicy(origin, getTlsOverrides())
  if (policy.legacyOpenSsl) {
    const confPath = getLegacyOpenSslConfPath()
    if (confPath) env.OPENSSL_CONF = confPath
  }

  const credentials = options.credentials
    ?? (origin ? getCredentialsForOrigin(credentialOriginKey(origin)) : null)

  return {
    invocation: buildSvnInvocation({ args, origin, policy, credentials }),
    env,
    policy
  }
}

/**
 * Spawns svn with the prepared invocation. The password (if any) is written to
 * stdin and stdin is closed immediately, so it never appears in argv.
 */
export function spawnSvn(args: string[], options: RunSvnOptions = {}): ChildProcessWithoutNullStreams {
  const prepared = prepareSvnInvocation(args, options)
  const proc = spawn(currentSvnBin(), prepared.invocation.args, {
    cwd: options.cwd,
    env: prepared.env,
    windowsHide: true
  })
  proc.stdin.on('error', () => { /* svn may exit before reading stdin */ })
  proc.stdin.end(prepared.invocation.stdin)
  return proc
}

const KILL_GRACE_MS = 1500

/** Terminates a process, escalating to SIGKILL if it has not exited after a grace period. */
export function terminateProcess(proc: { kill(signal?: NodeJS.Signals): boolean; exitCode: number | null; signalCode: NodeJS.Signals | null }, hasExited: () => boolean): void {
  try { proc.kill('SIGTERM') } catch { /* ignore */ }
  const timer = setTimeout(() => {
    if (!hasExited()) {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
    }
  }, KILL_GRACE_MS)
  timer.unref?.()
}

export class SvnCancelledError extends Error {
  constructor(message = 'Operación SVN cancelada') {
    super(message)
    this.name = 'SvnCancelledError'
  }
}

export function runSvn(args: string[], options: RunSvnOptions = {}): Promise<RunSvnResult> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new SvnCancelledError())
      return
    }

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawnSvn(args, options)
    } catch (error) {
      reject(error as Error)
      return
    }

    let stdout = ''
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    let exited = false
    let truncated = false
    let stopping = false
    let terminationError: Error | undefined
    let timeoutId: NodeJS.Timeout | undefined
    let idleId: NodeJS.Timeout | undefined
    const cmd = args[0] || 'svn'

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (idleId) clearTimeout(idleId)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finishResolve = (value: RunSvnResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(value)
    }
    const finishReject = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const kill = () => terminateProcess(proc, () => exited)

    // Callers may remove/retry a checkout after rejection. Wait for close so
    // the old process can no longer write into that directory.
    const stop = (error?: Error) => {
      if (stopping || settled) return
      stopping = true
      terminationError = error
      cleanup()
      kill()
    }
    function onAbort() {
      stop(new SvnCancelledError())
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const timeoutMs = options.timeoutMs ?? 0
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        stop(new Error(`Tiempo de espera agotado (${Math.ceil(timeoutMs / 1000)}s) al ejecutar SVN (${cmd})`))
      }, timeoutMs)
    }

    const idleMs = options.idleTimeoutMs ?? 0
    const armIdle = () => {
      if (idleMs <= 0 || settled || stopping) return
      if (idleId) clearTimeout(idleId)
      idleId = setTimeout(() => {
        stop(new Error(`SVN (${cmd}) no mostró actividad durante ${Math.ceil(idleMs / 60000)} min y se detuvo`))
      }, idleMs)
    }
    armIdle()

    proc.stdout.on('data', (chunk: Buffer) => {
      armIdle()
      if (stopping || truncated) return
      const maxBytes = options.maxStdoutBytes ?? 0
      if (maxBytes > 0 && stdoutBytes + chunk.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - stdoutBytes)
        stdout += chunk.subarray(0, remaining).toString()
        stdoutBytes = maxBytes
        truncated = true
        stop()
        return
      }
      stdoutBytes += chunk.length
      const value = chunk.toString()
      stdout += value
      options.onData?.(value)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      armIdle()
      const value = chunk.toString()
      if (stderr.length < 256 * 1024) stderr += value
      options.onErrorData?.(value)
    })
    proc.on('close', (code) => {
      exited = true
      if (terminationError) finishReject(terminationError)
      else if (truncated) finishResolve({ stdout, stderr, truncated: true })
      else if (code === 0) finishResolve({ stdout, stderr })
      else finishReject(new Error(stderr || `SVN exited with code ${code}`))
    })
    proc.on('exit', () => { exited = true })
    proc.on('error', (error) => {
      exited = true
      finishReject(error as Error)
    })
    if (options.signal?.aborted) onAbort()
  })
}
