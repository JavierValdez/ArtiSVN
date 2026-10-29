import { credentialOriginKey, parseSvnOrigin } from './svn-policy'

export interface CredentialUpdate {
  username: string
  password: string
  serverUrl: string
}

/** Reusing a stored password requires an existing binding for the same account/origin. */
export function resolveCredentialUpdate(
  update: CredentialUpdate,
  fallbackUrl: string,
  getBound: (originKey: string) => { username: string; password: string } | null
): CredentialUpdate {
  const serverUrl = update.serverUrl || fallbackUrl
  if (update.password) return { ...update, serverUrl }
  const origin = parseSvnOrigin(serverUrl)
  const bound = origin ? getBound(credentialOriginKey(origin)) : null
  if (!bound || bound.username !== update.username) {
    throw new Error('Ingresa la contraseña para este usuario y servidor; no se reutiliza la clave de otro origen.')
  }
  return { username: update.username, password: bound.password, serverUrl }
}
