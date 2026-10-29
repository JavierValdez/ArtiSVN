/**
 * Origin, credential-binding and TLS policy rules for SVN operations.
 *
 * Pure module (no Electron imports) so the security rules can be unit-tested.
 *
 * Policy summary (see docs in implementation notes / README):
 * - Credentials are bound to an origin (scheme://host:port). They are only sent
 *   to the exact origin they were saved for (plus the documented SAT alias
 *   equivalence). They are never sent over plain `http:`.
 * - TLS is strict (no certificate failures tolerated, default OpenSSL config)
 *   for every origin, except the SAT legacy SVN server which is only reachable
 *   with TLSv1.0 + DHE-RSA-AES256-SHA and presents an expired certificate
 *   issued by an internal CA (verified anonymously on 2026-10-27).
 */

import { EOL } from 'node:os'

export type SvnTlsMode = 'strict' | 'legacy-sat'

export type SvnTrustFailure = 'unknown-ca' | 'cn-mismatch' | 'expired' | 'not-yet-valid' | 'other'

export interface SvnTlsPolicy {
  mode: SvnTlsMode
  /** Use the legacy OpenSSL configuration (TLSv1.0, SECLEVEL=0, unsafe legacy renegotiation). */
  legacyOpenSsl: boolean
  /** Certificate failures svn is allowed to accept for this origin. */
  trustFailures: SvnTrustFailure[]
}

/** Exact SAT FQDN. No wildcard: other *.sat-interno.gob.gt hosts stay strict. */
export const SAT_LEGACY_SVN_HOST = 'linrepo00.sat-interno.gob.gt'
/** Short alias that resolves through the corporate DNS search domain. */
export const SAT_LEGACY_SVN_ALIAS = 'linrepo00'

const STRICT_POLICY: SvnTlsPolicy = Object.freeze({
  mode: 'strict',
  legacyOpenSsl: false,
  trustFailures: []
}) as SvnTlsPolicy

export interface SvnOrigin {
  scheme: string
  host: string
  port: string
  /** Canonical string form: `scheme://host:port` (port always explicit). */
  key: string
}

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'svn:': '3690',
  'svn+ssh:': '22'
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

export function isUrlLike(value: string): boolean {
  return URL_LIKE.test(String(value || '').trim())
}

/** Strips a trailing peg revision (`url@123`, `url@HEAD`) before parsing. */
function stripPegRevision(value: string): string {
  return value.replace(/@(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}]*\})$/i, '')
}

export function parseSvnOrigin(url: string): SvnOrigin | null {
  const raw = stripPegRevision(String(url || '').trim())
  if (!isUrlLike(raw)) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  const scheme = parsed.protocol.toLowerCase()
  if (scheme === 'file:') return null
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return null
  const port = parsed.port || DEFAULT_PORTS[scheme] || ''
  return { scheme, host, port, key: `${scheme}//${host}:${port}` }
}

/**
 * Hosts that are treated as the same server for credential binding. The SAT
 * short alias and the FQDN reach the same machine (same certificate CN).
 */
export function canonicalCredentialHost(host: string): string {
  const safeHost = String(host || '').toLowerCase()
  if (safeHost === SAT_LEGACY_SVN_ALIAS) return SAT_LEGACY_SVN_HOST
  return safeHost
}

export function credentialOriginKey(origin: SvnOrigin): string {
  return `${origin.scheme}//${canonicalCredentialHost(origin.host)}:${origin.port}`
}

export function credentialOriginKeyFromUrl(url: string): string | null {
  const origin = parseSvnOrigin(url)
  return origin ? credentialOriginKey(origin) : null
}

/** Only these schemes may carry a password. `http:` would expose it in clear text. */
export function isCredentialSafeScheme(scheme: string): boolean {
  return scheme === 'https:' || scheme === 'svn:' || scheme === 'svn+ssh:'
}

export type TlsPolicyOverrides = Record<string, SvnTlsMode>

export function resolveTlsPolicy(
  origin: SvnOrigin | null,
  overrides: TlsPolicyOverrides = {}
): SvnTlsPolicy {
  if (!origin || origin.scheme !== 'https:') return STRICT_POLICY

  const override = overrides[origin.key] ?? overrides[credentialOriginKey(origin)]
  if (override === 'strict') return STRICT_POLICY

  const isSatFqdn = origin.host === SAT_LEGACY_SVN_HOST
  const isSatAlias = origin.host === SAT_LEGACY_SVN_ALIAS
  // Overrides may only opt-in the legacy profile for an exact origin; they never
  // widen it to wildcards.
  const legacyRequested = override === 'legacy-sat'
  if (!isSatFqdn && !isSatAlias && !legacyRequested) return STRICT_POLICY

  // Empirically required for linrepo00 (2026-10-27): legacy OpenSSL + unknown-ca + expired.
  // not-yet-valid/other are kept as in previous releases for this exact host so the
  // legacy server keeps working if its certificate is reissued by the same internal CA.
  const trustFailures: SvnTrustFailure[] = ['unknown-ca', 'expired', 'not-yet-valid', 'other']
  // The short alias does not match the certificate CN (FQDN only, no SAN).
  if (isSatAlias) trustFailures.push('cn-mismatch')

  return { mode: 'legacy-sat', legacyOpenSsl: true, trustFailures }
}

/** svn options that consume the following argument as their value. */
const OPTIONS_WITH_VALUE = new Set([
  '-m', '--message', '-F', '--file', '-r', '--revision', '-c', '--change', '--depth', '--set-depth',
  '-x', '--extensions', '-l', '--limit', '--targets', '--accept', '--config-dir', '--config-option',
  '--username', '--password', '--encoding', '--show-item', '--native-eol', '--cl', '--changelist',
  '--diff-cmd', '--diff3-cmd', '--editor-cmd', '--search', '--search-and'
])
const VALUE_OPTIONS = OPTIONS_WITH_VALUE

export interface ParsedSvnArgs {
  /** Positional arguments (subcommand first), excluding option values. */
  positionals: string[]
  /** Index of the `--` separator, or -1. */
  separatorIndex: number
}

/**
 * Splits svn argv into positionals and options. Values of options such as
 * `-m <message>` are never treated as targets/URLs, and everything after `--`
 * is positional.
 */
export function parseSvnArgs(args: string[]): ParsedSvnArgs {
  const positionals: string[] = []
  let separatorIndex = -1
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (separatorIndex >= 0) {
      positionals.push(arg)
      continue
    }
    if (arg === '--') {
      separatorIndex = i
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (!arg.includes('=') && OPTIONS_WITH_VALUE.has(arg)) i += 1
      continue
    }
    positionals.push(arg)
  }
  return { positionals, separatorIndex }
}

/** Collects origins of URL-like positional arguments (targets), ignoring option values. */
export function collectArgOrigins(args: string[]): SvnOrigin[] {
  const origins: SvnOrigin[] = []
  for (const arg of parseSvnArgs(args).positionals) {
    const origin = parseSvnOrigin(arg)
    if (origin && !origins.some((candidate) => candidate.key === origin.key)) origins.push(origin)
  }
  return origins
}

export function buildTlsArgs(policy: SvnTlsPolicy): string[] {
  if (policy.trustFailures.length === 0) return []
  return [`--trust-server-cert-failures=${policy.trustFailures.join(',')}`]
}

/** Rejects any argument that tries to smuggle a password into argv. */
export function assertNoPasswordArgs(args: string[]): void {
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') break
    if (arg === '--password' || arg.startsWith('--password=')) {
      throw new Error('Las contraseñas SVN no pueden pasarse como argumento')
    }
    if (VALUE_OPTIONS.has(arg)) i += 1
  }
}

export interface SvnCredentials {
  username: string
  password: string
}

export interface SvnInvocationInput {
  args: string[]
  origin: SvnOrigin | null
  policy: SvnTlsPolicy
  /** Credentials already resolved for `origin` (or explicitly supplied by the user). */
  credentials: SvnCredentials | null
  /** When true no credential / non-interactive flags are added (e.g. `--version`). */
  bare?: boolean
}

export interface SvnInvocation {
  args: string[]
  /** Data to write to svn's stdin (`--password-from-stdin`). Empty when no password. */
  stdin: string
  sendsCredentials: boolean
}

/**
 * Builds the final argv for svn. The password is NEVER part of argv: it is sent
 * through stdin with `--password-from-stdin` (supported since svn 1.10; the
 * bundled client is 1.14.5).
 */
export function buildSvnInvocation(input: SvnInvocationInput): SvnInvocation {
  assertNoPasswordArgs(input.args)
  if (input.bare) return { args: [...input.args], stdin: '', sendsCredentials: false }

  const separator = input.args.indexOf('--')
  const commandArgs = separator < 0 ? [...input.args] : input.args.slice(0, separator)
  const targetArgs = separator < 0 ? [] : input.args.slice(separator)
  const args = [...commandArgs, '--non-interactive', ...buildTlsArgs(input.policy)]
  // A CLI password applies to svn:externals too, including a different server.
  // Never let a checkout/update/export/switch forward an origin-bound secret to an
  // external URL. Externals must be fetched as separate, origin-bound operations.
  // (`status` without `-u` is offline and is intentionally not listed, so local
  // changes inside externals stay visible.)
  const visitsExternals = new Set(['checkout', 'co', 'update', 'up', 'export', 'switch', 'sw'])
  if (visitsExternals.has(input.args[0]) && !commandArgs.includes('--ignore-externals')) {
    args.push('--ignore-externals')
  }
  const credentials = input.credentials
  const canSend = Boolean(
    credentials?.username
    && input.origin
    && isCredentialSafeScheme(input.origin.scheme)
  )
  if (!canSend || !credentials) return { args: [...args, ...targetArgs], stdin: '', sendsCredentials: false }

  if (/[\r\n]/.test(credentials.password)) {
    throw new Error('La contraseña SVN contiene saltos de línea no soportados')
  }
  args.push('--username', credentials.username, '--password-from-stdin')
  // svn reads stdin using APR_EOL_STR: a bare LF becomes part of the password on Windows.
  return { args: [...args, ...targetArgs], stdin: `${credentials.password}${EOL}`, sendsCredentials: true }
}
