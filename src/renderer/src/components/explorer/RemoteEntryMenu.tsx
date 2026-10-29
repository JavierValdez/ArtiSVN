import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteEntry } from '../../types/svn'

export interface EntryMenuState {
  entry: RemoteEntry
  top: number
  left: number
}

/** Floating "···" menu state: positioning and close on outside click/Escape/scroll/resize. */
export function useEntryMenu() {
  const [entryMenu, setEntryMenu] = useState<EntryMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!entryMenu) return
    const closeMenu = () => setEntryMenu(null)
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) closeMenu()
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    document.addEventListener('scroll', closeMenu, true)
    window.addEventListener('resize', closeMenu)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('resize', closeMenu)
    }
  }, [entryMenu])

  const openAtButton = useCallback((entry: RemoteEntry, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect()
    const menuWidth = 220
    const menuHeight = entry.kind === 'dir' ? 340 : 268
    const margin = 12
    const left = Math.max(margin, Math.min(window.innerWidth - menuWidth - margin, rect.right - menuWidth))
    const top = rect.bottom + 6 + menuHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - menuHeight - 6)
      : rect.bottom + 6
    setEntryMenu({ entry, top, left })
  }, [])

  const closeMenu = useCallback(() => setEntryMenu(null), [])

  return { entryMenu, menuRef, openAtButton, closeMenu }
}

export interface EntryMenuActions {
  openLog: (entry: RemoteEntry) => void
  copy: (text: string, label: string) => void
  download: (entry: RemoteEntry) => void
  view: (entry: RemoteEntry) => void
  checkout: (entry: RemoteEntry) => void
  exportCopy: (entry: RemoteEntry) => void
  create: (type: 'folder' | 'file', entry: RemoteEntry) => void
  search: (entry: RemoteEntry) => void
}

export function RemoteEntryMenu({ menu, menuRef, onClose, actions }: {
  menu: EntryMenuState | null
  menuRef: MutableRefObject<HTMLDivElement | null>
  onClose: () => void
  actions: EntryMenuActions
}) {
  if (!menu) return null
  const { entry, top, left } = menu
  const isDir = entry.kind === 'dir'
  const item = (label: string, run: () => void) => (
    <button className="tree-dropdown-item" onClick={() => { onClose(); run() }}>
      {label}
    </button>
  )

  return createPortal(
    <div className="tree-item-dropdown tree-item-dropdown-floating" ref={menuRef} style={{ top, left }}>
      {item('🕘 Ver log', () => actions.openLog(entry))}
      {item('📋 Copiar URL', () => actions.copy(entry.url, 'URL copiada'))}
      {item(`📋 Copiar revisión (r${entry.revision})`, () => actions.copy(String(entry.revision), 'Revisión copiada'))}
      {item('📋 Copiar URL@revisión', () => actions.copy(`${entry.url}@${entry.revision}`, 'URL@revisión copiada'))}
      {!isDir && (
        <>
          <div className="tree-dropdown-divider" />
          {item('⬇ Descargar archivo', () => actions.download(entry))}
          {item('👁 Ver archivo', () => actions.view(entry))}
        </>
      )}
      {isDir && (
        <>
          <div className="tree-dropdown-divider" />
          {item(entry.isCheckedOut ? '🔁 Volver a clonar' : '🧬 Clonar repositorio', () => actions.checkout(entry))}
          {item('📦 Descargar copia', () => actions.exportCopy(entry))}
          {item('📁 Crear subcarpeta', () => actions.create('folder', entry))}
          {item('📄 Crear archivo', () => actions.create('file', entry))}
          <div className="tree-dropdown-divider" />
          {item('🔍 Buscar en esta carpeta', () => actions.search(entry))}
        </>
      )}
    </div>,
    document.body
  )
}
