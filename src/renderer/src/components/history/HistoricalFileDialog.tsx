import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { RevisionSnapshot } from '../../types/svn'
import DiffViewer from '../DiffViewer'

/**
 * Shared modal for a file changed in a revision, used by the local history
 * (HistoryView) and the remote history (Explorer). Two views:
 *  - «Diff»: changes introduced by that revision (default every time it opens).
 *  - «Archivo completo»: exact snapshot of the file AT that revision, loaded
 *    only when the tab is first chosen and cached while the modal is open.
 *
 * Each open gets a new `session`; the dialog is keyed by it, so late responses
 * from a previous file/revision (or after closing) are discarded.
 */

export interface HistoricalFileTarget {
  /** Unique per open; used as React key and request identity. */
  session: number
  svnPath: string
  fileName: string
  revision: number
  /** Bound at open time to the repo/base URL of that history. */
  loadDiff: () => Promise<string>
  loadSnapshot: () => Promise<RevisionSnapshot>
}

export type HistoricalFileTargetInput = Omit<HistoricalFileTarget, 'session'>

/** Holds the currently open historical file (or none). */
export function useHistoricalFileTarget() {
  const [target, setTarget] = useState<HistoricalFileTarget | null>(null)
  const sessionRef = useRef(0)
  const open = useCallback((input: HistoricalFileTargetInput) => {
    sessionRef.current += 1
    setTarget({ ...input, session: sessionRef.current })
  }, [])
  const close = useCallback(() => setTarget(null), [])
  return { target, open, close }
}

type Tab = 'diff' | 'full'

type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: string }

function cleanError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || '')
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim() || fallback
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Loads a value with request identity: stale or post-unmount responses are ignored. */
function useGuardedLoader<T>(load: () => Promise<T>, fallbackError: string) {
  const [state, setState] = useState<LoadState<T>>({ status: 'idle' })
  const requestRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const run = useCallback(async () => {
    const request = ++requestRef.current
    setState({ status: 'loading' })
    try {
      const value = await load()
      if (aliveRef.current && request === requestRef.current) setState({ status: 'ready', value })
    } catch (error) {
      if (aliveRef.current && request === requestRef.current) setState({ status: 'error', error: cleanError(error, fallbackError) })
    }
  }, [fallbackError, load])

  return { state, run }
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="hist-file-status" role="status">
      <div className="spinner spinner-lg" />
      <span>{label}</span>
    </div>
  )
}

function ErrorWithRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="hist-file-status hist-file-error" role="alert">
      <span>{message}</span>
      <button className="btn btn-default" onClick={onRetry}>Reintentar</button>
    </div>
  )
}

function DiffPanel({ state, fileName, onRetry }: { state: LoadState<string>; fileName: string; onRetry: () => void }) {
  if (state.status === 'idle' || state.status === 'loading') return <Spinner label="Cargando diff…" />
  if (state.status === 'error') return <ErrorWithRetry message={state.error} onRetry={onRetry} />
  const diff = state.value
  if (diff && diff.includes('@@')) return <DiffViewer diff={diff} filePath={fileName} />
  return <div className="hist-file-message">{diff || '(sin cambios)'}</div>
}

function FullFilePanel({ state, revision, onRetry }: { state: LoadState<RevisionSnapshot>; revision: number; onRetry: () => void }) {
  if (state.status === 'idle' || state.status === 'loading') {
    return <Spinner label={`Cargando el archivo completo en r${revision}…`} />
  }
  if (state.status === 'error') return <ErrorWithRetry message={state.error} onRetry={onRetry} />

  const snapshot = state.value
  if (snapshot.kind === 'dir') {
    return <div className="hist-file-notice">En r{revision} esta ruta es una carpeta: no hay contenido de archivo que mostrar.</div>
  }
  if (snapshot.kind === 'binary') {
    return (
      <div className="hist-file-notice">
        Archivo binario en r{revision}: no se muestra como texto. Usa ⬇ Descargar en la lista de archivos para obtenerlo.
      </div>
    )
  }
  return (
    <>
      {snapshot.truncated && (
        <div className="hist-file-notice hist-file-notice-inline">
          Se muestran los primeros {formatBytes(snapshot.bytes)} del archivo; el resto no se cargó. Descárgalo para verlo completo.
        </div>
      )}
      {snapshot.encoding === 'latin1' && (
        <div className="hist-file-notice hist-file-notice-inline">
          El archivo no está en UTF-8; se muestra como ISO-8859-1.
        </div>
      )}
      {snapshot.text.length === 0 ? (
        <div className="hist-file-message">(archivo vacío en r{revision})</div>
      ) : (
        <pre className="hist-file-full" tabIndex={0} aria-label={`Contenido completo en r${revision}`}>
          <code>{snapshot.text}</code>
        </pre>
      )}
    </>
  )
}

function HistoricalFileDialogBody({ target, onClose }: { target: HistoricalFileTarget; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('diff')
  const diff = useGuardedLoader(target.loadDiff, 'Error al obtener el diff')
  const full = useGuardedLoader(target.loadSnapshot, 'No se pudo leer el archivo en esa revisión')
  const baseId = useId()
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ diff: null, full: null })

  // Diff is loaded on open; the full file only when its tab is first selected (then cached).
  useEffect(() => { void diff.run() }, [])
  useEffect(() => {
    if (tab === 'full' && full.state.status === 'idle') void full.run()
  }, [tab, full.state.status])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const selectTab = (next: Tab) => {
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (event.key === 'Home') selectTab('diff')
      else if (event.key === 'End') selectTab('full')
      else selectTab(tab === 'diff' ? 'full' : 'diff')
    }
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'diff', label: 'Diff' },
    { id: 'full', label: 'Archivo completo' }
  ]

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="dialog hist-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
      >
        <div className="dialog-title hist-file-header">
          <span id={`${baseId}-title`} className="hist-file-title">{target.fileName}</span>
          <span className="hist-file-rev">r{target.revision}</span>
          <div className="hist-file-tabs" role="tablist" aria-label="Vista del archivo" onKeyDown={onTabKeyDown}>
            {tabs.map(({ id, label }) => (
              <button
                key={id}
                ref={(node) => { tabRefs.current[id] = node }}
                id={`${baseId}-tab-${id}`}
                role="tab"
                type="button"
                className={`hist-file-tab ${tab === id ? 'active' : ''}`}
                aria-selected={tab === id}
                aria-controls={`${baseId}-panel`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost hist-file-close" aria-label="Cerrar" onClick={onClose}>✕</button>
        </div>
        <div className="dialog-sub hist-file-path">{target.svnPath}</div>
        <div
          id={`${baseId}-panel`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab}`}
          className="hist-file-panel"
        >
          {tab === 'diff'
            ? <DiffPanel state={diff.state} fileName={target.fileName} onRetry={() => void diff.run()} />
            : <FullFilePanel state={full.state} revision={target.revision} onRetry={() => void full.run()} />}
        </div>
      </div>
    </div>
  )
}

export default function HistoricalFileDialog({ target, onClose }: { target: HistoricalFileTarget | null; onClose: () => void }) {
  if (!target) return null
  // Remount per session: a new file/revision always starts on «Diff» with fresh state.
  return <HistoricalFileDialogBody key={target.session} target={target} onClose={onClose} />
}
