import { formatClipboardText } from '../../utils/clipboard'

/** Shared bits of the remote explorer (dialogs, hooks and tree). */

export type ToastFn = (msg: string, type?: 'success' | 'error' | 'info') => void

export function getSvnApi(): any {
  const api = (window as any).svn
  if (!api) {
    throw new Error('No se encontró la API de Electron (window.svn). Ejecuta la app con `npm run dev`.')
  }
  return api
}

export function copyToClipboard(text: string, label: string, toast: ToastFn): void {
  navigator.clipboard.writeText(formatClipboardText(text))
  toast(label, 'success')
}

export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
  'zip', 'jar', 'war', 'tar', 'gz', 'rar', '7z',
  'exe', 'dll', 'so', 'dylib', 'class',
  'mp3', 'mp4', 'avi', 'mov', 'wav', 'flac',
  'doc', 'docx'
])

export const ACTION_LABEL: Record<string, string> = {
  M: '✏️',
  A: '➕',
  D: '🗑️',
  R: '🔄'
}

export function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  const icons: Record<string, string> = {
    java: '☕',
    xml: '📋',
    json: '{}',
    html: '🌐',
    css: '🎨',
    js: '📜',
    ts: '📘',
    sql: '🗃️',
    txt: '📄',
    md: '📝',
    png: '🖼️',
    jpg: '🖼️',
    jpeg: '🖼️',
    gif: '🖼️',
    pdf: '📕',
    zip: '📦',
    jar: '📦',
    war: '📦',
    sh: '⚙️',
    bat: '⚙️',
    properties: '⚙️',
    yml: '⚙️',
    yaml: '⚙️'
  }
  return icons[ext || ''] || '📄'
}
