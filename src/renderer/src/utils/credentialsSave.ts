import type { Credentials } from '../types/svn'

export interface CredentialsInput {
  username: string
  password: string
  serverUrl: string
}

export interface CredentialsApi {
  setCredentials: (creds: CredentialsInput) => Promise<boolean>
  updateCredentials: (creds: CredentialsInput) => Promise<boolean>
  getCredentials: () => Promise<Credentials | null>
}

export type CredentialsSaveResult =
  | { ok: true; credentials: Credentials | null }
  | { ok: false; error: string }

/** Strips Electron's "Error invoking remote method 'x': Error:" prefix. */
export function cleanIpcError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || '')
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim()
  return cleaned || fallback
}

/** Keeps only public fields: the renderer never stores a password. */
export function toPublicCredentials(creds: Credentials | null | undefined): Credentials | null {
  if (!creds || !creds.username) return null
  return {
    username: creds.username,
    serverUrl: creds.serverUrl || '',
    hasPassword: Boolean(creds.hasPassword)
  }
}

/**
 * Saves credentials through IPC and reloads the sanitized state from main.
 * `mode: 'replace'` requires a password; `'update'` lets main reuse the stored
 * password only for the same user and origin (main rejects otherwise).
 * Never throws: errors are returned so the dialog can stay open with a message.
 */
export async function saveCredentials(
  api: CredentialsApi,
  input: CredentialsInput,
  mode: 'replace' | 'update'
): Promise<CredentialsSaveResult> {
  try {
    if (mode === 'replace' || input.password) await api.setCredentials(input)
    else await api.updateCredentials(input)
  } catch (error) {
    return { ok: false, error: cleanIpcError(error, 'No se pudieron guardar las credenciales') }
  }
  try {
    return { ok: true, credentials: toPublicCredentials(await api.getCredentials()) }
  } catch {
    // Saved, but the refreshed state could not be read: keep only public fields.
    return { ok: true, credentials: toPublicCredentials({ username: input.username, serverUrl: input.serverUrl, hasPassword: true }) }
  }
}
