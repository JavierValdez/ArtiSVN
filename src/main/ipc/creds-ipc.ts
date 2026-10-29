import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  clearStoredCredentials,
  deleteRemote,
  getCurrentServerUrl,
  getCredentialsForOrigin,
  getStoredCredentials,
  listRemotes,
  renameRemote,
  saveRemote,
  selectRemote,
  setCurrentServerUrl,
  storeDelete,
  writeStoredCredentials
} from '../services/store'
import { getSvnBin, getSvnBinInfo, runSvn, setSvnBin } from '../services/svn-runtime'
import { isCredentialSafeScheme, parseSvnOrigin } from '../services/svn-policy'
import { resolveCredentialUpdate } from '../services/credential-update'
import { validateReadOnlyRemoteUrl } from '../services/read-contract'
import { handleTrusted, optionalString, requireString } from './guard'

interface CredentialsPayload {
  username: string
  password: string
  serverUrl: string
}

function parseCredentialsPayload(value: unknown, requirePassword: boolean): CredentialsPayload {
  if (!value || typeof value !== 'object') throw new Error('Credenciales inválidas')
  const raw = value as Record<string, unknown>
  const username = requireString(raw.username ?? '', 'username', 512).trim()
  const password = requireString(raw.password ?? '', 'password', 4096)
  const serverUrl = requireString(raw.serverUrl ?? '', 'serverUrl', 8192).trim()
  if (requirePassword && !password) throw new Error('La contraseña es requerida')
  if (/[\r\n]/.test(password)) throw new Error('La contraseña contiene caracteres no soportados')
  if (serverUrl) {
    const origin = parseSvnOrigin(serverUrl)
    if (!origin || !isCredentialSafeScheme(origin.scheme)) {
      throw new Error('Las credenciales solo se guardan para servidores https://, svn:// o svn+ssh://')
    }
  }
  return { username, password, serverUrl }
}

function classifyPingError(err: unknown) {
  const msg = err instanceof Error ? err.message || '' : ''
  if (msg.includes('Authentication') || msg.includes('authorization') || msg.includes('E170001') || msg.includes('E215004')) {
    return { ok: false, authError: true, message: msg }
  }
  return { ok: false, authError: false, message: msg }
}

function getEventWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerCredentialsIpc(): void {
  // Never returns the password: only whether one is stored.
  handleTrusted('creds:get', () => {
    const creds = getStoredCredentials()
    if (!creds) return null
    return { username: creds.username, serverUrl: creds.serverUrl, hasPassword: Boolean(creds.password) }
  })

  handleTrusted('creds:set', (_event, payload: unknown) => {
    const creds = parseCredentialsPayload(payload, true)
    writeStoredCredentials(creds)
    if (creds.serverUrl) setCurrentServerUrl(creds.serverUrl)
    return true
  })

  handleTrusted('creds:update', (_event, payload: unknown) => {
    const creds = parseCredentialsPayload(payload, false)
    const current = getStoredCredentials()
    const updated = resolveCredentialUpdate(creds, current?.serverUrl || '', getCredentialsForOrigin)
    writeStoredCredentials(updated)
    if (updated.serverUrl) setCurrentServerUrl(updated.serverUrl)
    return true
  })

  handleTrusted('creds:clear', () => {
    clearStoredCredentials()
    return true
  })

  handleTrusted('creds:getServerUrl', () => getCurrentServerUrl())

  handleTrusted('creds:setServerUrl', (_event, serverUrl: unknown) => {
    const nextUrl = requireString(serverUrl, 'serverUrl', 8192).trim()
    if (!nextUrl) throw new Error('La URL del servidor es requerida')
    setCurrentServerUrl(validateReadOnlyRemoteUrl(nextUrl))
    return true
  })

  handleTrusted('remotes:list', () => listRemotes())
  handleTrusted('remotes:save', (_event, payload: unknown) => {
    const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    return saveRemote({
      name: requireString(raw.name ?? '', 'name', 512),
      url: validateReadOnlyRemoteUrl(requireString(raw.url ?? '', 'url', 8192))
    })
  })
  handleTrusted('remotes:select', (_event, remoteId: unknown) => selectRemote(requireString(remoteId, 'remoteId', 256)))
  handleTrusted('remotes:delete', (_event, remoteId: unknown) => deleteRemote(requireString(remoteId, 'remoteId', 256)))
  handleTrusted('remotes:rename', (_event, remoteId: unknown, name: unknown, url: unknown) => {
    const nextUrl = optionalString(url, 'url', 8192)
    return renameRemote(
      requireString(remoteId, 'remoteId', 256),
      requireString(name, 'name', 512),
      nextUrl ? validateReadOnlyRemoteUrl(nextUrl) : undefined
    )
  })

  handleTrusted('svn:getBinPath', async () => getSvnBinInfo())

  // Legacy reset API. Custom executable changes require the native picker below.
  handleTrusted('svn:setBinPath', async (_event, binPath: unknown) => {
    const next = (optionalString(binPath, 'binPath', 4096) || '').trim()
    if (!next || next.toLowerCase() === 'auto') {
      storeDelete('svnBinPath')
      return setSvnBin('svn')
    }
    throw new Error('Selecciona el ejecutable SVN con el selector de archivos para cambiar el binario.')
  })

  // Custom executables receive credentials: a native user choice is mandatory.
  handleTrusted('svn:pickBinPath', async (event) => {
    const owner = getEventWindow(event)
    const options = {
      title: 'Seleccionar binario svn',
      properties: ['openFile'] as Array<'openFile'>,
      buttonLabel: 'Usar este binario'
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return setSvnBin(result.filePaths[0])
  })

  handleTrusted('svn:ping', async (_event, url: unknown) => {
    try {
      await runSvn(['info', '--xml', validateReadOnlyRemoteUrl(requireString(url, 'url', 8192))], { timeoutMs: 15000 })
      return { ok: true }
    } catch (err) {
      return classifyPingError(err)
    }
  })

  // Connection test with typed credentials: password goes through stdin, never persisted.
  handleTrusted('svn:pingWithCreds', async (_event, payload: unknown) => {
    const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    const url = validateReadOnlyRemoteUrl(requireString(raw.url ?? '', 'url', 8192))
    const origin = parseSvnOrigin(url)
    if (!origin || !isCredentialSafeScheme(origin.scheme)) {
      return { ok: false, authError: false, message: 'No se envían contraseñas por http://. Usa https://.' }
    }
    const username = requireString(raw.username ?? '', 'username', 512)
    const password = requireString(raw.password ?? '', 'password', 4096)
    try {
      await runSvn(['info', '--xml', url], { credentials: { username, password }, timeoutMs: 15000 })
      return { ok: true }
    } catch (err) {
      return classifyPingError(err)
    }
  })

  handleTrusted('svn:version', async () => {
    try {
      const { stdout } = await runSvn(['--version', '--quiet'], { skipAuth: true, timeoutMs: 10_000 })
      return { version: stdout.trim(), bin: getSvnBin() }
    } catch {
      return { version: null, bin: getSvnBin() }
    }
  })

  handleTrusted('svn:install', async (event) => {
    const targetWindow = getEventWindow(event)
    if (process.platform === 'win32') {
      throw new Error('En Windows, ArtiSVN incluye SVN integrado. Si hay problemas, descarga TortoiseSVN desde https://tortoisesvn.net')
    }
    return new Promise((resolvePromise, reject) => {
      const brewBin = existsSync('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew'
      if (!existsSync(brewBin)) {
        reject(new Error('Homebrew no está instalado. Visita https://brew.sh'))
        return
      }
      const proc = spawn(brewBin, ['install', 'subversion'], {
        env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }
      })
      const forward = (d: Buffer) => {
        if (targetWindow && !targetWindow.isDestroyed()) targetWindow.webContents.send('svn:install-progress', d.toString())
      }
      proc.stdout.on('data', forward)
      proc.stderr.on('data', forward)
      proc.on('close', (code) => {
        if (code === 0) resolvePromise({ success: true, bin: setSvnBin('svn').bin })
        else reject(new Error('Error al instalar SVN via Homebrew'))
      })
      proc.on('error', reject)
    })
  })
}
