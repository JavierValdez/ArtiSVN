import { useCallback, useState } from 'react'
import type { RemoteEntry } from '../../types/svn'
import { normalizeError, suggestRemoteName } from './explorerUtils'
import { getSvnApi, type ToastFn } from './shared'

export interface CreateRemoteState {
  type: 'folder' | 'file'
  parentUrl: string
  parentName: string
  name: string
  message: string
  content: string
  running: boolean
}

export interface SaveRemoteState {
  url: string
  name: string
}

/** "Save as remote" and "create folder/file on the server" dialogs. */
export function useRemoteWriteDialogs(options: {
  toast: ToastFn
  onSaveRemote: (name: string, url: string) => Promise<void>
  /** Refreshes the tree after a remote item is created under `parentUrl`. */
  onRemoteCreated: (parentUrl: string) => Promise<void>
}) {
  const { toast, onSaveRemote, onRemoteCreated } = options
  const [createRemote, setCreateRemote] = useState<CreateRemoteState | null>(null)
  const [saveRemoteDialog, setSaveRemoteDialog] = useState<SaveRemoteState | null>(null)

  const openSaveRemote = useCallback((url: string) => {
    const nextUrl = url.trim()
    if (!nextUrl) {
      toast('Ingresa una URL de servidor SVN válida', 'error')
      return
    }
    setSaveRemoteDialog({ url: nextUrl, name: suggestRemoteName(nextUrl) })
  }, [toast])

  const updateSaveRemote = useCallback((patch: Partial<SaveRemoteState>) => {
    setSaveRemoteDialog((prev) => prev ? { ...prev, ...patch } : null)
  }, [])

  const closeSaveRemote = useCallback(() => setSaveRemoteDialog(null), [])

  const submitSaveRemote = useCallback(async () => {
    if (!saveRemoteDialog) return
    const name = saveRemoteDialog.name.trim()
    if (!name) { toast('El nombre es requerido', 'error'); return }
    try {
      await onSaveRemote(name, saveRemoteDialog.url)
      setSaveRemoteDialog(null)
    } catch (err: any) {
      toast(normalizeError(err) || 'No se pudo guardar el servidor remoto', 'error')
    }
  }, [onSaveRemote, saveRemoteDialog, toast])

  const openCreateRemote = useCallback((type: 'folder' | 'file', parent: RemoteEntry) => {
    setCreateRemote({
      type,
      parentUrl: parent.url,
      parentName: parent.name.replace(/\/$/, ''),
      name: '',
      message: '',
      content: '',
      running: false
    })
  }, [])

  const updateCreateRemote = useCallback((patch: Partial<CreateRemoteState>) => {
    setCreateRemote((prev) => prev ? { ...prev, ...patch } : null)
  }, [])

  const closeCreateRemote = useCallback(() => setCreateRemote(null), [])

  const submitCreateRemote = useCallback(async () => {
    if (!createRemote) return
    const name = createRemote.name.trim()
    if (!name) {
      toast('Escribe un nombre', 'error')
      return
    }

    setCreateRemote((prev) => (prev ? { ...prev, running: true } : null))
    try {
      const svn = getSvnApi()
      if (createRemote.type === 'folder') {
        await svn.remoteMkdir(createRemote.parentUrl, name, createRemote.message.trim() || undefined)
        toast('Carpeta creada correctamente', 'success')
      } else {
        await svn.remoteCreateFile(createRemote.parentUrl, name, createRemote.content, createRemote.message.trim() || undefined)
        toast('Archivo creado correctamente', 'success')
      }
      await onRemoteCreated(createRemote.parentUrl)
      setCreateRemote(null)
    } catch (err: any) {
      setCreateRemote((prev) => (prev ? { ...prev, running: false } : null))
      toast(normalizeError(err) || 'Error al crear elemento remoto', 'error')
    }
  }, [createRemote, onRemoteCreated, toast])

  return {
    createRemote,
    openCreateRemote,
    updateCreateRemote,
    closeCreateRemote,
    submitCreateRemote,
    saveRemoteDialog,
    openSaveRemote,
    updateSaveRemote,
    closeSaveRemote,
    submitSaveRemote
  }
}

export function SaveRemoteDialog({ state, onChange, onClose, onSubmit }: {
  state: SaveRemoteState | null
  onChange: (patch: Partial<SaveRemoteState>) => void
  onClose: () => void
  onSubmit: () => void
}) {
  if (!state) return null
  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 480 }}>
        <div className="dialog-title">💾 Guardar como servidor remoto</div>
        <div className="form-field">
          <label className="form-label">URL</label>
          <input
            className="form-input"
            value={state.url}
            onChange={(e) => onChange({ url: e.target.value })}
            placeholder="https://servidor/svn"
          />
        </div>
        <div className="form-field">
          <label className="form-label">Nombre</label>
          <input
            className="form-input"
            value={state.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Mi Servidor SVN"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }}
          />
        </div>
        <div className="dialog-actions">
          <button className="btn btn-default" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={!state.name.trim()}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  )
}

export function CreateRemoteDialog({ state, onChange, onClose, onSubmit }: {
  state: CreateRemoteState | null
  onChange: (patch: Partial<CreateRemoteState>) => void
  onClose: () => void
  onSubmit: () => void
}) {
  if (!state) return null
  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 520 }}>
        <div className="dialog-title">
          {state.type === 'folder' ? '📁 Crear subcarpeta' : '📄 Crear archivo'}
        </div>
        <div className="dialog-sub" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
          Dentro de: {state.parentUrl}
        </div>

        <div className="form-field">
          <label className="form-label">Nombre</label>
          <input
            className="form-input"
            value={state.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={state.type === 'folder' ? 'nueva-carpeta' : 'archivo.txt'}
            autoFocus
          />
        </div>

        {state.type === 'file' && (
          <div className="form-field">
            <label className="form-label">Contenido inicial (opcional)</label>
            <textarea
              className="form-input"
              value={state.content}
              onChange={(e) => onChange({ content: e.target.value })}
              rows={6}
              placeholder="Contenido del archivo..."
              style={{ resize: 'vertical', fontFamily: 'SF Mono, Menlo, monospace' }}
            />
          </div>
        )}

        <div className="form-field">
          <label className="form-label">Mensaje de commit (opcional)</label>
          <input
            className="form-input"
            value={state.message}
            onChange={(e) => onChange({ message: e.target.value })}
            placeholder={state.type === 'folder' ? 'Crear carpeta...' : 'Crear archivo...'}
          />
        </div>

        <div className="dialog-actions">
          <button className="btn btn-default" onClick={onClose} disabled={state.running}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={state.running || !state.name.trim()}
          >
            {state.running ? '⟳ Creando...' : 'Crear'}
          </button>
        </div>
      </div>
    </div>
  )
}
