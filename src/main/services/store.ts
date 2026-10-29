import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateAgentToken } from '../agent/token'
import { resolveLocalPaths } from './local-paths'
import { credentialOriginKey, isCredentialSafeScheme, parseSvnOrigin } from './svn-policy'

export interface StoredCredentials {
  username: string
  password: string
  serverUrl: string
}

export interface StoredRemote {
  id: string
  name: string
  url: string
  createdAt: string
}

interface StoredRemotesState {
  exists: boolean
  remotes: StoredRemote[]
}

interface StoredAgentIntegration {
  enabled?: boolean
  tokenEncrypted?: string
}

export function getStorePath(): string {
  return resolveLocalPaths({
    appDataPath: app.getPath('appData')
  }).configFile
}

function readStore(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(getStorePath(), 'utf-8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    throw new Error('No se pudo leer la configuración de ArtiSVN sin riesgo de pérdida de datos.', {
      cause: error
    })
  }
}

function writeStore(data: Record<string, unknown>): void {
  const storePath = getStorePath()
  const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`
  mkdirSync(dirname(storePath), { recursive: true })
  writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
  try {
    renameSync(temporaryPath, storePath)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

export function storeGet<T = unknown>(key: string): T | undefined {
  return readStore()[key] as T | undefined
}

export function storeSet(key: string, value: unknown): void {
  const data = readStore()
  data[key] = value
  writeStore(data)
}

export function storeDelete(key: string): void {
  const data = readStore()
  delete data[key]
  writeStore(data)
}

export function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  return safeStorage.encryptString(value).toString('base64')
}

export function decryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return value
  }
}

export function writeStoredCredentials(creds: StoredCredentials): void {
  const passwordEncrypted = encryptSecret(creds.password)
  storeSet('credentials', {
    username: creds.username,
    passwordEncrypted,
    serverUrl: creds.serverUrl
  })
  bindCredentialsToOrigin(creds.serverUrl, creds.username, passwordEncrypted)
}

interface StoredOriginCredential {
  username: string
  passwordEncrypted: string
  boundAt: string
}

const CREDENTIALS_BY_ORIGIN_KEY = 'credentialsByOrigin'

function readCredentialsByOrigin(): Record<string, StoredOriginCredential> | null {
  const raw = storeGet<Record<string, unknown>>(CREDENTIALS_BY_ORIGIN_KEY)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const result: Record<string, StoredOriginCredential> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    if (typeof entry.passwordEncrypted !== 'string') continue
    result[key] = {
      username: String(entry.username || ''),
      passwordEncrypted: entry.passwordEncrypted,
      boundAt: String(entry.boundAt || '')
    }
  }
  return result
}

/**
 * Binds the (already encrypted) password to the exact origin of `serverUrl`.
 * Credentials for `http:` origins are never stored for automatic use.
 */
function bindCredentialsToOrigin(serverUrl: string, username: string, passwordEncrypted: string): void {
  const origin = parseSvnOrigin(serverUrl)
  if (!origin || !isCredentialSafeScheme(origin.scheme) || !username) return
  const current = readCredentialsByOrigin() || {}
  current[credentialOriginKey(origin)] = {
    username,
    passwordEncrypted,
    boundAt: new Date().toISOString()
  }
  storeSet(CREDENTIALS_BY_ORIGIN_KEY, current)
}

/**
 * One-time migration for stores written before credentials were origin-bound:
 * bind the legacy credential to the server URL it was saved with. The encrypted
 * value is copied as-is (never decrypted and rewritten in clear text).
 */
function migrateLegacyCredentialBinding(): Record<string, StoredOriginCredential> {
  const existing = readCredentialsByOrigin()
  if (existing) return existing

  const stored = storeGet<Record<string, unknown>>('credentials')
  const result: Record<string, StoredOriginCredential> = {}
  if (stored && typeof stored === 'object') {
    // Ensure plaintext legacy entries get encrypted first.
    if (typeof stored.passwordEncrypted !== 'string' && typeof stored.password === 'string') {
      getStoredCredentials()
    }
    const refreshed = storeGet<Record<string, unknown>>('credentials') || {}
    const boundUrl = String(refreshed.serverUrl || storeGet('serverUrl') || '')
    const origin = parseSvnOrigin(boundUrl)
    if (
      origin
      && isCredentialSafeScheme(origin.scheme)
      && typeof refreshed.passwordEncrypted === 'string'
      && refreshed.username
    ) {
      result[credentialOriginKey(origin)] = {
        username: String(refreshed.username),
        passwordEncrypted: refreshed.passwordEncrypted,
        boundAt: new Date().toISOString()
      }
    }
  }
  storeSet(CREDENTIALS_BY_ORIGIN_KEY, result)
  return result
}

/** Returns credentials bound to the given canonical origin key, if any. */
export function getCredentialsForOrigin(originKey: string): { username: string; password: string } | null {
  if (!originKey) return null
  const map = migrateLegacyCredentialBinding()
  const entry = map[originKey]
  if (!entry || !entry.username) return null
  return { username: entry.username, password: decryptSecret(entry.passwordEncrypted) }
}

/** Origins (canonical keys) that have credentials bound. Never returns secrets. */
export function listCredentialOriginKeys(): string[] {
  return Object.keys(migrateLegacyCredentialBinding())
}

export function clearStoredCredentials(): void {
  storeDelete('credentials')
  storeDelete(CREDENTIALS_BY_ORIGIN_KEY)
}

export function getStoredCredentials(): StoredCredentials | null {
  const stored = storeGet<Record<string, unknown>>('credentials')
  if (!stored || typeof stored !== 'object') return null

  let password: string
  if (typeof stored.passwordEncrypted === 'string' && stored.passwordEncrypted) {
    password = decryptSecret(stored.passwordEncrypted)
  } else if (typeof stored.password === 'string') {
    password = stored.password
    writeStoredCredentials({
      username: String(stored.username || ''),
      password,
      serverUrl: String(stored.serverUrl || '')
    })
  } else {
    return null
  }

  return {
    username: String(stored.username || ''),
    password,
    serverUrl: String(stored.serverUrl || '')
  }
}

export function getCurrentServerUrl(defaultValue = ''): string {
  const creds = getStoredCredentials()
  return creds?.serverUrl || String(storeGet('serverUrl') || defaultValue)
}

function updateStoredCredentialsServerUrl(serverUrl: string): void {
  // Pin legacy credentials before navigation can change their displayed URL.
  migrateLegacyCredentialBinding()
  const stored = storeGet<Record<string, unknown>>('credentials')
  if (!stored || typeof stored !== 'object') return

  // Preserve the encrypted representation exactly as stored. Reading/decrypting and
  // spreading credentials here would write the password back as plaintext.
  storeSet('credentials', { ...stored, serverUrl })
}

export function setCurrentServerUrl(url: string): void {
  const nextUrl = String(url || '').trim()
  if (!nextUrl) return

  updateStoredCredentialsServerUrl(nextUrl)
  storeSet('serverUrl', nextUrl)
}

export function clearCurrentServerUrl(): void {
  updateStoredCredentialsServerUrl('')
  storeSet('serverUrl', '')
}

function getStoredRemotesState(): StoredRemotesState {
  const raw = storeGet<unknown[]>('remoteServers')
  if (!Array.isArray(raw)) return { exists: false, remotes: [] }

  return {
    exists: true,
    remotes: raw
      .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
      .filter((value) => Boolean(value.id && value.name && value.url))
      .map((value) => ({
        id: String(value.id),
        name: String(value.name),
        url: String(value.url),
        createdAt: String(value.createdAt || new Date().toISOString())
      }))
  }
}

function saveStoredRemotes(remotes: StoredRemote[]): void {
  storeSet('remoteServers', remotes)
}

export function ensureRemotesSeeded(): StoredRemote[] {
  const { exists, remotes } = getStoredRemotesState()
  if (exists) return remotes

  const currentUrl = getCurrentServerUrl().trim()
  if (!currentUrl) {
    saveStoredRemotes([])
    return []
  }

  const seeded: StoredRemote[] = [{
    id: `remote-${Date.now()}`,
    name: 'Servidor principal',
    url: currentUrl,
    createdAt: new Date().toISOString()
  }]
  saveStoredRemotes(seeded)
  return seeded
}

export function listRemotes(): Array<StoredRemote & { active: boolean }> {
  const remotes = ensureRemotesSeeded()
  const activeUrl = getCurrentServerUrl()
  return remotes.map((remote) => ({
    ...remote,
    active: remote.url === activeUrl
  }))
}

export function saveRemote(payload: { name: string; url: string }): StoredRemote & { active: true } {
  const name = String(payload?.name || '').trim()
  const url = String(payload?.url || '').trim()
  if (!name) throw new Error('El nombre del repositorio remoto es requerido')
  if (!url) throw new Error('La URL del repositorio remoto es requerida')

  const remotes = ensureRemotesSeeded()
  const normalized = url.replace(/\/$/, '')
  const byUrl = remotes.find((remote) => remote.url.replace(/\/$/, '') === normalized)

  const saved: StoredRemote = byUrl
    ? { ...byUrl, name, url }
    : {
      id: `remote-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name,
      url,
      createdAt: new Date().toISOString()
    }

  const next = byUrl
    ? remotes.map((remote) => (remote.id === byUrl.id ? saved : remote))
    : [...remotes, saved]
  saveStoredRemotes(next)
  setCurrentServerUrl(saved.url)
  return { ...saved, active: true }
}

export function selectRemote(remoteId: string): StoredRemote & { active: true } {
  const id = String(remoteId || '').trim()
  if (!id) throw new Error('Remote inválido')

  const remote = ensureRemotesSeeded().find((candidate) => candidate.id === id)
  if (!remote) throw new Error('Repositorio remoto no encontrado')
  setCurrentServerUrl(remote.url)
  return { ...remote, active: true }
}

export function deleteRemote(remoteId: string): true {
  const id = String(remoteId || '').trim()
  if (!id) throw new Error('Remote inválido')

  const remotes = ensureRemotesSeeded()
  const deleted = remotes.find((remote) => remote.id === id)
  const next = remotes.filter((remote) => remote.id !== id)
  saveStoredRemotes(next)

  if (deleted?.url === getCurrentServerUrl()) {
    if (next.length > 0) setCurrentServerUrl(next[0].url)
    else clearCurrentServerUrl()
  }

  return true
}

export function renameRemote(remoteId: string, name: string, url?: string): StoredRemote {
  const id = String(remoteId || '').trim()
  const nextName = String(name || '').trim()
  if (!id) throw new Error('Remote inválido')
  if (!nextName) throw new Error('El nombre es requerido')

  const remotes = ensureRemotesSeeded()
  const remote = remotes.find((candidate) => candidate.id === id)
  if (!remote) throw new Error('Repositorio remoto no encontrado')

  const nextUrl = String(url || '').trim() || remote.url
  saveStoredRemotes(remotes.map((candidate) => (
    candidate.id === id ? { ...candidate, name: nextName, url: nextUrl } : candidate
  )))
  if (remote.url === getCurrentServerUrl()) setCurrentServerUrl(nextUrl)
  return { ...remote, name: nextName, url: nextUrl }
}

export function getAgentIntegrationState(): { enabled: boolean; token: string | null } {
  const stored = storeGet<StoredAgentIntegration>('agentIntegration')
  if (!stored || typeof stored !== 'object') {
    return { enabled: false, token: null }
  }

  const token = typeof stored.tokenEncrypted === 'string' && stored.tokenEncrypted
    ? decryptSecret(stored.tokenEncrypted)
    : null
  return { enabled: Boolean(stored.enabled), token }
}

export function ensureAgentIntegrationToken(): string {
  const current = getAgentIntegrationState()
  if (current.token) return current.token

  const token = generateAgentToken()
  storeSet('agentIntegration', {
    enabled: current.enabled,
    tokenEncrypted: encryptSecret(token)
  })
  return token
}

export function setAgentIntegrationEnabled(enabled: boolean): { enabled: boolean; token: string | null } {
  const current = getAgentIntegrationState()
  const token = enabled ? (current.token || ensureAgentIntegrationToken()) : current.token
  storeSet('agentIntegration', {
    enabled,
    ...(token ? { tokenEncrypted: encryptSecret(token) } : {})
  })
  return { enabled, token }
}

export function regenerateAgentIntegrationToken(): string {
  const current = getAgentIntegrationState()
  const token = generateAgentToken()
  storeSet('agentIntegration', {
    enabled: current.enabled,
    tokenEncrypted: encryptSecret(token)
  })
  return token
}
