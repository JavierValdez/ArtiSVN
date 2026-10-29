import type { CheckoutState, ExportState } from './useCheckoutExport'

/** Externals are never fetched automatically (see svn-policy/externals services). */
const EXTERNALS_HINT = 'Los svn:externals no se descargan automáticamente; si necesitas uno, descárgalo por separado desde su URL.'

export function CheckoutDialog({ state, onNameChange, onClose, onConfirm }: {
  state: CheckoutState | null
  onNameChange: (name: string) => void
  onClose: () => void
  onConfirm: () => void
}) {
  if (!state) return null
  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 460 }}>
        <div className="dialog-title">
          {state.done ? '✅ Clonación completada' : '🧬 Clonar repositorio'}
        </div>
        <div className="dialog-sub" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {state.url}
        </div>

        {!state.running && !state.done && (
          <div className="form-field">
            <label className="form-label">Nombre del directorio local</label>
            <input
              className="form-input"
              value={state.name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="nombre-del-repositorio"
              autoFocus
            />
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
              Se creará en ~/Documents/ArtiSVN/{state.name}
            </div>
            <div className="checkout-externals-hint" style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
              {EXTERNALS_HINT}
            </div>
          </div>
        )}

        {(state.running || state.done) && (
          <div className="progress-log" style={{ marginBottom: 12, height: 120 }}>
            {state.log || 'Iniciando clonación...'}
          </div>
        )}

        {state.running && (
          <div className="progress-bar-wrap">
            <div className="progress-bar" />
          </div>
        )}

        <div className="dialog-actions">
          <button className="btn btn-default" onClick={onClose} disabled={state.running}>
            {state.done ? 'Cerrar' : 'Cancelar'}
          </button>
          {!state.done && (
            <button className="btn btn-primary" onClick={onConfirm} disabled={state.running}>
              {state.running ? '⟳ Clonando...' : '🧬 Clonar'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function ExportDialog({ state, onNameChange, onPickFolder, onOpenResult, onClose, onConfirm }: {
  state: ExportState | null
  onNameChange: (name: string) => void
  onPickFolder: () => void
  onOpenResult: (path: string) => void
  onClose: () => void
  onConfirm: () => void
}) {
  if (!state) return null
  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 480 }}>
        <div className="dialog-title">
          {state.done ? '✅ Exportación completada' : '📦 Descargar copia'}
        </div>
        <div className="dialog-sub" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {state.url}
        </div>

        {!state.running && !state.done && (
          <>
            <div className="form-field">
              <label className="form-label">Carpeta de destino</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="form-input"
                  value={state.targetDir}
                  readOnly
                  placeholder="Selecciona una carpeta..."
                  style={{ flex: 1, color: state.targetDir ? undefined : 'var(--text3)' }}
                />
                <button className="btn btn-default" onClick={onPickFolder}>
                  Seleccionar...
                </button>
              </div>
            </div>
            <div className="form-field">
              <label className="form-label">Nombre de la carpeta</label>
              <input
                className="form-input"
                value={state.name}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="nombre-exportacion"
                autoFocus
              />
              {state.targetDir && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                  Se guardará en: {state.targetDir}/{state.name}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                Sin metadatos SVN — copia independiente de archivos
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                {EXTERNALS_HINT}
              </div>
            </div>
          </>
        )}

        {(state.running || state.done) && (
          <div className="progress-log" style={{ marginBottom: 12, height: 120 }}>
            {state.log || 'Iniciando exportación...'}
          </div>
        )}

        {state.running && (
          <div className="progress-bar-wrap">
            <div className="progress-bar" />
          </div>
        )}

        {state.done && state.resultPath && (
          <div style={{ marginBottom: 12 }}>
            <button className="btn btn-default" style={{ width: '100%' }} onClick={() => onOpenResult(state.resultPath)}>
              📁 Abrir en Finder
            </button>
          </div>
        )}

        <div className="dialog-actions">
          <button className="btn btn-default" onClick={onClose} disabled={state.running}>
            {state.done ? 'Cerrar' : 'Cancelar'}
          </button>
          {!state.done && (
            <button
              className="btn btn-primary"
              onClick={onConfirm}
              disabled={state.running || !state.targetDir || !state.name.trim()}
            >
              {state.running ? '⟳ Exportando...' : '📦 Exportar'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
