import { app } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getStoredCredentials, storeGet, storeSet } from './store'

export interface RunSvnOptions {
  cwd?: string
  onData?: (chunk: string) => void
  onErrorData?: (chunk: string) => void
  skipAuth?: boolean
  timeoutMs?: number
  allowLegacySslFallback?: boolean
  forceLegacySsl?: boolean
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

let svnBin = findSvnBin(String(storeGet('svnBinPath') || ''))

export function getSvnBin(): string {
  return svnBin
}

export function setSvnBin(binPath: string): { bin: string; version: string | null } {
  const safePath = String(binPath || '').trim()
  if (!safePath) throw new Error('Ruta de binario SVN inválida')
  const candidate = findSvnBin(safePath)
  if (!canExecuteSvn(candidate)) {
    throw new Error('No se pudo ejecutar el binario SVN indicado')
  }
  svnBin = candidate
  storeSet('svnBinPath', safePath)
  const result = spawnSync(svnBin, ['--version', '--quiet'], {
    env: { ...buildEnvWithExtraPath(), LANG: 'en_US.UTF-8' },
    encoding: 'utf-8',
    timeout: 5000
  })
  return { bin: svnBin, version: result.status === 0 ? String(result.stdout || '').trim() || null : null }
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
  return { bin: svnBin, configured, version }
}

function getSvnAuthArgs(): string[] {
  const creds = getStoredCredentials()
  const args = [
    '--non-interactive',
    '--trust-server-cert',
    '--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other'
  ]
  if (creds?.username) {
    args.push('--username', creds.username, '--password', creds.password)
  }
  return args
}

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

function isLegacySslError(message: string): boolean {
  return /E120171|SSL communication|tlsv1 alert|handshake/i.test(message)
}

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

function runSvnOnce(
  args: string[],
  options: RunSvnOptions,
  useLegacySsl: boolean
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const allArgs = options.skipAuth ? [...args] : [...args, ...getSvnAuthArgs()]
    const env = { ...buildEnvWithExtraPath(), LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv
    if (useLegacySsl) {
      const confPath = getLegacyOpenSslConfPath()
      if (confPath) env.OPENSSL_CONF = confPath
    }

    const proc = spawn(svnBin, allArgs, {
      cwd: options.cwd,
      env
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeoutId: NodeJS.Timeout | undefined

    const finishResolve = (value: { stdout: string; stderr: string }) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)
      resolve(value)
    }

    const finishReject = (error: Error) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)
      reject(error)
    }

    const timeoutMs = options.timeoutMs ?? 0
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        const cmd = args[0] || 'svn'
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (!settled) proc.kill('SIGKILL')
        }, 1500)
        finishReject(new Error(`Tiempo de espera agotado (${Math.ceil(timeoutMs / 1000)}s) al ejecutar SVN (${cmd})`))
      }, timeoutMs)
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      const value = chunk.toString()
      stdout += value
      options.onData?.(value)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const value = chunk.toString()
      stderr += value
      options.onErrorData?.(value)
    })
    proc.on('close', (code) => {
      if (code === 0) finishResolve({ stdout, stderr })
      else finishReject(new Error(stderr || `SVN exited with code ${code}`))
    })
    proc.on('error', (error) => finishReject(error as Error))
  })
}

export async function runSvn(
  args: string[],
  options: RunSvnOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const firstTryLegacy = options.forceLegacySsl !== false
  const shouldFallback = options.allowLegacySslFallback !== false

  try {
    return await runSvnOnce(args, options, firstTryLegacy)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (firstTryLegacy || !shouldFallback || !isLegacySslError(message)) {
      throw error
    }
    return runSvnOnce(args, options, true)
  }
}

export function buildInlineAuthArgs(username: string, password: string): string[] {
  return [
    '--non-interactive',
    '--trust-server-cert',
    '--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other',
    '--username',
    username,
    '--password',
    password
  ]
}

export function getSvnSpawnContext(): {
  bin: string
  env: NodeJS.ProcessEnv
  authArgs: string[]
} {
  const env = { ...buildEnvWithExtraPath(), LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv
  const confPath = getLegacyOpenSslConfPath()
  if (confPath) env.OPENSSL_CONF = confPath
  return { bin: svnBin, env, authArgs: getSvnAuthArgs() }
}
