import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * IPC sender validation. Every privileged handler is registered through
 * `handleTrusted`, which only accepts invocations from the main frame of an
 * ArtiSVN BrowserWindow that is showing the bundled renderer (or the
 * electron-vite dev server in development).
 */

function rendererFileUrl(): string {
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

function devRendererOrigin(): string | null {
  const devUrl = process.env.NODE_ENV === 'development' ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!devUrl) return null
  try {
    return new URL(devUrl).origin
  } catch {
    return null
  }
}

export function isTrustedRendererUrl(url: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    const expectedFile = new URL(rendererFileUrl())
    if (parsed.protocol === 'file:') {
      if (parsed.host !== expectedFile.host) return false
      const actual = decodeURIComponent(parsed.pathname)
      const expected = decodeURIComponent(expectedFile.pathname)
      return process.platform === 'win32'
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected
    }
    const devOrigin = devRendererOrigin()
    return Boolean(devOrigin) && parsed.origin === devOrigin
  } catch {
    return false
  }
}

export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const sender: WebContents = event.sender
  if (!sender || sender.isDestroyed()) return false
  if (!BrowserWindow.fromWebContents(sender)) return false
  const frame = event.senderFrame
  if (!frame || frame !== sender.mainFrame) return false
  return isTrustedRendererUrl(frame.url)
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event)) {
    throw new Error('Solicitud IPC rechazada: origen no confiable')
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleTrusted<Args extends any[], R>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => R | Promise<R>
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    return handler(event, ...(args as Args))
  })
}

/** Payload helpers: reject wrong types early instead of coercing silently. */
export function requireString(value: unknown, name: string, maxLength = 32_768): string {
  if (typeof value !== 'string') throw new Error(`Parámetro inválido: ${name}`)
  if (value.length > maxLength) throw new Error(`Parámetro demasiado largo: ${name}`)
  return value
}

export function optionalString(value: unknown, name: string, maxLength = 32_768): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, name, maxLength)
}

export function requireStringArray(value: unknown, name: string, maxItems = 20_000): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Parámetro inválido: ${name}`)
  return value.map((item, index) => requireString(item, `${name}[${index}]`))
}

export function requirePositiveInt(value: unknown, name: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`Parámetro inválido: ${name}`)
  return number
}

export function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  return requirePositiveInt(value, name)
}
