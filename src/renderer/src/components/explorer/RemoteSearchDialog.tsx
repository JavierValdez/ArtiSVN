import type { RemoteSearchResult } from '../../types/svn'
import { getFileIcon } from './shared'
import { describeSearchStop, type RemoteSearchDialogState } from './useRemoteSearch'

function highlightText(text: string, query: string) {
  if (!query.trim()) return text
  const q = query.trim()
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="tree-search-highlight">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}

function SearchProgress({ state }: { state: RemoteSearchDialogState }) {
  const progress = state.searchProgress
  return (
    <div className="search-running">
      <div className="spinner" />
      {progress?.listingStats ? (
        // Phase 1: directory exploration
        <span>
          Explorando… {progress.listingStats.entries} entradas
          en {progress.listingStats.dirs} carpetas
        </span>
      ) : state.deepSearch && progress && progress.total > 0 ? (
        // Phase 2: content search
        <div className="search-running-detail">
          <span>Buscando en contenido… {progress.searched} de {progress.total} archivos</span>
          <div className="search-progress-bar-wrap">
            <div
              className="search-progress-bar-fill"
              style={{ width: `${Math.round((progress.searched / progress.total) * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <span>Buscando…</span>
      )}
    </div>
  )
}

function SearchResultRow({ result: r, query, onSelect }: {
  result: RemoteSearchResult
  query: string
  onSelect: (result: RemoteSearchResult) => void
}) {
  return (
    <div
      className="search-result-item"
      role="button"
      tabIndex={0}
      title={r.kind === 'revision' ? 'Abrir esta revisión en el historial remoto' : 'Ir a este resultado dentro del árbol'}
      onClick={() => onSelect(r)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(r)
        }
      }}
    >
      <span className="search-result-icon">
        {r.kind === 'revision' ? '🕘' : r.kind === 'dir' ? '📁' : getFileIcon(r.name)}
      </span>
      <div className="search-result-body">
        <span className="search-result-name">
          {r.kind === 'revision' ? <strong>{r.name}</strong> : highlightText(r.name, query)}
        </span>
        <span className="search-result-path">
          {r.kind === 'revision' ? highlightText(r.revisionMessage || r.path, query) : r.path}
        </span>
      </div>
      <span className={`search-result-badge ${r.matchType}`}>
        {r.matchType === 'name' ? 'nombre' : r.matchType === 'comment' ? 'comentario' : 'contenido'}
      </span>
    </div>
  )
}

export default function RemoteSearchDialog({ state, onQueryChange, onDeepSearchChange, onRun, onCancel, onClose, onSelectResult }: {
  state: RemoteSearchDialogState
  onQueryChange: (query: string) => void
  onDeepSearchChange: (deep: boolean) => void
  onRun: () => void
  onCancel: () => void
  onClose: () => void
  onSelectResult: (result: RemoteSearchResult) => void
}) {
  if (!state.open) return null
  const stopNote = state.searched && !state.running ? describeSearchStop(state.stopReason) : null

  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 600, maxWidth: '90vw' }}>
        <div className="dialog-title">🔍 Buscar en carpeta</div>
        <div className="dialog-sub" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {state.folderName} · {state.url}
        </div>

        <div className="form-field" style={{ marginTop: 16 }}>
          <input
            className="form-input"
            value={state.query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Nombre de archivo o carpeta..."
            autoFocus
            disabled={state.running}
            onKeyDown={(e) => { if (e.key === 'Enter' && !state.running) onRun() }}
          />
        </div>

        <label className="search-deep-label">
          <input
            type="checkbox"
            checked={state.deepSearch}
            onChange={(e) => onDeepSearchChange(e.target.checked)}
            disabled={state.running}
          />
          <span>Búsqueda profunda (buscar también en contenido de archivos)</span>
        </label>

        {state.running && <SearchProgress state={state} />}

        {/* Results appear progressively as they stream in */}
        {state.results.length > 0 && (
          <div className="search-results">
            <div className="search-results-header">
              {state.results.length} resultado{state.results.length !== 1 ? 's' : ''}
              {state.running && <span className="search-results-streaming"> · buscando…</span>}
            </div>
            <div className="search-results-list">
              {state.results.map((r, i) => (
                <SearchResultRow key={i} result={r} query={state.query} onSelect={onSelectResult} />
              ))}
            </div>
          </div>
        )}

        {state.searched && !state.running && !state.error && state.results.length === 0 && (
          <div className="search-results">
            <div className="search-empty">No se encontraron resultados para "{state.query}"</div>
          </div>
        )}

        {state.searched && state.error && (
          <div className="search-results">
            <div className="search-error">{state.error}</div>
          </div>
        )}

        {stopNote && (
          <div className="search-results">
            <div className="search-empty">{stopNote}</div>
          </div>
        )}

        <div className="dialog-actions">
          {state.running ? (
            <button className="btn btn-default" onClick={onCancel}>⏹ Detener</button>
          ) : (
            <button className="btn btn-default" onClick={onClose}>Cerrar</button>
          )}
          <button
            className="btn btn-primary"
            onClick={onRun}
            disabled={state.running || !state.query.trim()}
          >
            {state.running ? '⟳ Buscando...' : '🔍 Buscar'}
          </button>
        </div>
      </div>
    </div>
  )
}
