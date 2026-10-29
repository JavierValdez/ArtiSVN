import { getFileIcon, type ToastFn } from './shared'
import type { FileViewerState } from './useRemotePreview'

/** Plain-text viewer for remote files. */
export function FileViewerDialog({ state, onClose, toast }: {
  state: FileViewerState
  onClose: () => void
  toast: ToastFn
}) {
  if (!state.open) return null
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" style={{ width: '85vw', maxWidth: 1000, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div className="dialog-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{getFileIcon(state.name)} {state.name}</span>
          <button className="btn btn-ghost" style={{ marginLeft: 'auto', padding: '2px 8px' }} onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={{ fontFamily: 'SF Mono, Menlo, monospace', fontSize: 11, color: 'var(--text3)', marginBottom: 8, wordBreak: 'break-all' }}>
          {state.url}
        </div>
        {state.loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <div className="spinner spinner-lg" />
          </div>
        ) : state.error ? (
          <div style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>{state.error}</div>
        ) : (
          <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
            <pre style={{ margin: 0, padding: 16, fontFamily: 'SF Mono, Menlo, monospace', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>
              {state.content || '(archivo vacío)'}
            </pre>
          </div>
        )}
        {!state.loading && state.content && (
          <div className="dialog-actions" style={{ marginTop: 12 }}>
            <button
              className="btn btn-default"
              onClick={() => {
                navigator.clipboard.writeText(state.content || '')
                toast('Copiado al portapapeles', 'success')
              }}
            >
              📋 Copiar
            </button>
            <button className="btn btn-default" onClick={onClose}>
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
