import { useState, useEffect } from 'react'
import { LocalRepo, LogEntry } from '../types/svn'
import HistoricalFileDialog, { useHistoricalFileTarget } from './history/HistoricalFileDialog'
import PdfPreviewDialog, { PdfPreviewState } from './PdfPreviewDialog'
import VerticalResizeHandle from './VerticalResizeHandle'
import { isWordFile, isPreviewableFile } from '../utils/fileTypes'
import { formatClipboardText } from '../utils/clipboard'
import { useResizablePanel } from '../hooks/useResizablePanel'

interface Props {
  repo: LocalRepo
  toast: (msg: string, type?: 'success' | 'error' | 'info') => void
  onWorkingCopyChanged?: () => void | Promise<void>
}

const LOG_PAGE_SIZE = 100

const ACTION_META: Record<string, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'action-modified' },
  A: { label: 'A', cls: 'action-added' },
  D: { label: 'D', cls: 'action-deleted' },
  R: { label: 'R', cls: 'action-replaced' },
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleString('es-GT', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatDateShort(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('es-GT', { day: 'numeric', month: 'short', year: 'numeric' })
}

function authorInitials(author: string): string {
  return (author || '?').slice(0, 2).toUpperCase()
}

function splitPath(fullPath: string): { dir: string; file: string } {
  const parts = fullPath.replace(/^\//, '').split('/')
  const file = parts.pop() || fullPath
  const dir = parts.length > 0 ? '/' + parts.join('/') : ''
  return { dir, file }
}

export default function HistoryView({ repo, toast, onWorkingCopyChanged }: Props) {
  const [log, setLog] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [selected, setSelected] = useState<LogEntry | null>(null)
  const historicalFile = useHistoricalFileTarget()
  const [repoInfo, setRepoInfo] = useState<{ url: string; rootUrl: string } | null>(null)
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewState | null>(null)
  const [restoringKey, setRestoringKey] = useState<string | null>(null)
  const {
    containerRef: layoutRef,
    width: historyListWidth,
    isResizing: isHistoryListResizing,
    resizeHandleProps: historyListResizeHandleProps
  } = useResizablePanel<HTMLDivElement>({
    storageKey: 'layout.historyListWidth',
    defaultWidth: 340,
    minWidth: 260,
    maxWidth: 620,
    minRemainingWidth: 420
  })

  useEffect(() => {
    historicalFile.close()
    setPdfPreview(null)
    loadLog()
  }, [repo.path])

  const loadLog = async () => {
    setLoading(true)
    setHasMore(false)
    try {
      const [entries, info] = await Promise.all([
        window.svn.log(repo.path, LOG_PAGE_SIZE),
        window.svn.info(repo.path).catch(() => null)
      ])
      setLog(entries)
      if (entries.length > 0) setSelected(entries[0])
      else setSelected(null)
      if (info) setRepoInfo({ url: info.url, rootUrl: info.rootUrl })

      const lastRevision = entries.length > 0 ? entries[entries.length - 1].revision : 0
      setHasMore(entries.length === LOG_PAGE_SIZE && lastRevision > 1)
    } catch (err: any) {
      toast(err.message || 'Error al cargar historial', 'error')
    } finally {
      setLoading(false)
    }
  }

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(formatClipboardText(text))
    toast(label, 'success')
  }

  const loadMore = async () => {
    if (loading || loadingMore || !hasMore || log.length === 0) return

    const oldestLoadedRevision = log[log.length - 1].revision
    const nextFromRevision = oldestLoadedRevision - 1
    if (nextFromRevision < 1) {
      setHasMore(false)
      return
    }

    setLoadingMore(true)
    try {
      const moreEntries = await window.svn.log(repo.path, LOG_PAGE_SIZE, nextFromRevision)
      if (moreEntries.length === 0) {
        setHasMore(false)
        return
      }

      setLog((prev) => {
        const seen = new Set(prev.map((entry) => entry.revision))
        const deduped = moreEntries.filter((entry) => !seen.has(entry.revision))
        return [...prev, ...deduped]
      })

      const lastRevision = moreEntries[moreEntries.length - 1].revision
      setHasMore(moreEntries.length === LOG_PAGE_SIZE && lastRevision > 1)
    } catch (err: any) {
      toast(err.message || 'Error al cargar más historial', 'error')
    } finally {
      setLoadingMore(false)
    }
  }

  /** Opens the shared Diff / Archivo completo modal, bound to this repo and revision. */
  const openFileDiff = (svnPath: string, revision: number) => {
    const repoPath = repo.path
    const parts = svnPath.split('/')
    historicalFile.open({
      svnPath,
      fileName: parts[parts.length - 1] || svnPath,
      revision,
      loadDiff: () => window.svn.revisionFileDiff(repoPath, revision, svnPath),
      loadSnapshot: () => window.svn.revisionFileContent(repoPath, revision, svnPath)
    })
  }

  const openPdfAtRevision = async (svnPath: string, revision: number) => {
    const fileName = svnPath.split('/').filter(Boolean).pop() || svnPath
    if (!repoInfo?.rootUrl) {
      toast('No se pudo obtener la URL base para previsualizar el PDF', 'error')
      return
    }

    setPdfPreview({
      title: fileName,
      subtitle: `${repo.name} · ${svnPath}`,
      base64: null,
      loading: true,
      error: null,
      badge: `r${revision}`,
      fileType: isWordFile(fileName) ? 'word' : 'pdf'
    })

    try {
      const previewUrl = `${repoInfo.rootUrl}${svnPath}@${revision}`
      const preview = await window.svn.getRemotePreviewFile(previewUrl, fileName)
      setPdfPreview((prev) => prev ? {
        ...prev,
        title: preview.name,
        base64: preview.base64,
        loading: false
      } : prev)
    } catch (err: any) {
      setPdfPreview((prev) => prev ? {
        ...prev,
        loading: false,
        error: err.message || 'No se pudo abrir el archivo'
      } : prev)
    }
  }

  const restorePathToWorkingCopy = async (entry: LogEntry, path: LogEntry['paths'][number]) => {
    const itemLabel = path.path.split('/').filter(Boolean).pop() || path.path
    const sourceRevision = path.action === 'D' ? entry.revision - 1 : entry.revision
    if (sourceRevision < 1) {
      toast('No existe una revisión anterior disponible para restaurar este elemento', 'error')
      return
    }

    const prompt = path.action === 'D'
      ? `¿Restaurar "${itemLabel}" desde r${sourceRevision} a tu copia local?\n\nEsto sobrescribirá el contenido actual en esa ruta.`
      : `¿Traer "${itemLabel}" desde r${sourceRevision} a tu copia local?\n\nEsto sobrescribirá el contenido actual en esa ruta.`
    if (!confirm(prompt)) return

    const key = `${entry.revision}:${path.path}:${path.action}`
    setRestoringKey(key)
    try {
      const result = await window.svn.restorePathAtRevision(repo.path, entry.revision, path.path, path.action)
      toast(
        result.kind === 'dir'
          ? `Carpeta restaurada desde r${result.restoredRevision}`
          : `Archivo restaurado desde r${result.restoredRevision}`,
        'success'
      )
      await onWorkingCopyChanged?.()
    } catch (err: any) {
      toast(err.message || 'No se pudo restaurar el elemento a la copia local', 'error')
    } finally {
      setRestoringKey(null)
    }
  }

  return (
    <div className="history-layout" ref={layoutRef}>
      {/* Left: log list */}
      <div className="history-list" style={{ width: historyListWidth }}>
        <div className="changes-list-header">
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>
            {log.length > 0 ? `${log.length} revisiones` : 'Historial'}
          </span>
          <button
            className="btn btn-ghost"
            style={{ padding: '2px 6px', fontSize: 11 }}
            onClick={loadLog}
            disabled={loading}
            title="Recargar historial"
          >
            ⟳
          </button>
        </div>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
            <div className="spinner spinner-lg" />
          </div>
        ) : log.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div className="empty-state-title">Sin historial</div>
          </div>
        ) : (
          <>
            {log.map((entry) => (
              <div
                key={entry.revision}
                className={`history-item ${selected?.revision === entry.revision ? 'selected' : ''}`}
                onClick={() => setSelected(entry)}
              >
                <div className="history-item-row">
                  <div className="history-avatar">{authorInitials(entry.author)}</div>
                  <div className="history-item-body">
                    <div className="history-msg">{entry.message || '(sin mensaje)'}</div>
                    <div className="history-meta">
                      <span className="history-author">{entry.author}</span>
                      <span className="history-dot">·</span>
                      <span>{formatDateShort(entry.date)}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div className="history-rev-badge">r{entry.revision}</div>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: '0 4px', fontSize: 10, opacity: 0.55 }}
                      title="Copiar revisión"
                      onClick={(e) => {
                        e.stopPropagation()
                        copy(String(entry.revision), 'Revisión copiada')
                      }}
                    >
                      📋
                    </button>
                  </div>
                </div>
              </div>
            ))}
            <div className="history-list-footer">
              {hasMore ? (
                <button className="btn btn-default history-load-more-btn" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? '⟳ Cargando...' : 'Cargar más'}
                </button>
              ) : (
                <div className="history-list-end">No hay más revisiones</div>
              )}
            </div>
          </>
        )}
      </div>

      <VerticalResizeHandle
        active={isHistoryListResizing}
        label="Ajustar ancho de la lista de historial"
        valueNow={historyListWidth}
        valueMin={260}
        valueMax={620}
        {...historyListResizeHandleProps}
      />

      {/* Right: detail */}
      <div className="history-detail">
        {selected ? (
          <>
            {/* Header */}
            <div className="history-detail-header">
              <div className="history-detail-avatar">{authorInitials(selected.author)}</div>
              <div className="history-detail-meta">
                <div className="history-detail-author">{selected.author}</div>
                <div className="history-detail-date">{formatDate(selected.date)}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <div className="history-detail-rev-badge">r{selected.revision}</div>
                <button
                  className="btn btn-ghost"
                  style={{ padding: '1px 7px', fontSize: 11 }}
                  title="Copiar número de revisión"
                  onClick={() => copy(String(selected.revision), 'Revisión copiada')}
                >
                  📋 r{selected.revision}
                </button>
                {repoInfo && (
                  <>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: '1px 7px', fontSize: 11 }}
                      title={`Copiar URL del repositorio remoto\n${formatClipboardText(repoInfo.url)}`}
                      onClick={() => copy(repoInfo.url, 'URL copiada')}
                    >
                      📋 URL
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: '1px 7px', fontSize: 11 }}
                      title={`Copiar URL@revisión\n${formatClipboardText(`${repoInfo.url}@${selected.revision}`)}`}
                      onClick={() => copy(`${repoInfo.url}@${selected.revision}`, 'URL@revisión copiada')}
                    >
                      📋 URL@rev
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Commit message */}
            <div className="history-detail-msg">
              {selected.message || '(sin mensaje de commit)'}
            </div>

            {/* Changed files */}
            {selected.paths.length > 0 && (
              <div className="history-files-section">
                <div className="history-paths-title">
                  Archivos afectados
                  <span className="history-paths-count">{selected.paths.length}</span>
                </div>
                <div className="history-files-list">
                  {selected.paths.map((p, i) => {
                    const meta = ACTION_META[p.action] || { label: p.action, cls: 'action-other' }
                    const { dir, file } = splitPath(p.path)
                    const canDiff = p.action !== 'D'
                    const opensPreview = canDiff && isPreviewableFile(p.path)
                    const restoreKey = `${selected.revision}:${p.path}:${p.action}`
                    const isRestoring = restoringKey === restoreKey
                    const restoreRevision = p.action === 'D' ? selected.revision - 1 : selected.revision
                    const canRestore = restoreRevision >= 1
                    return (
                      <div
                        key={i}
                        className={`history-path-item ${canDiff ? 'history-path-item-clickable' : ''}`}
                        onClick={() => canDiff && (opensPreview ? openPdfAtRevision(p.path, selected.revision) : openFileDiff(p.path, selected.revision))}
                        title={canDiff ? (opensPreview ? 'Ver documento de esta revisión' : 'Ver diff de este archivo') : ''}
                      >
                        <span className={`history-action-badge ${meta.cls}`}>{meta.label}</span>
                        <div className="history-path-text" style={{ flex: 1 }}>
                          <span className="history-path-file">{file}</span>
                          {dir && <span className="history-path-dir">{dir}</span>}
                        </div>
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '0 5px', fontSize: 10, opacity: 0.72, flexShrink: 0 }}
                          title={canRestore
                            ? (p.action === 'D'
                              ? `Restaurar a copia local desde r${restoreRevision}`
                              : `Traer esta versión a la copia local (r${restoreRevision})`)
                            : 'No existe una revisión anterior disponible para restaurar este elemento'}
                          onClick={(e) => {
                            e.stopPropagation()
                            void restorePathToWorkingCopy(selected, p)
                          }}
                          disabled={isRestoring || !canRestore}
                        >
                          {isRestoring ? '⟳' : '↩'}
                        </button>
                        {repoInfo && (
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '0 5px', fontSize: 10, opacity: 0.6, flexShrink: 0 }}
                            title={`Copiar URL@revisión\n${formatClipboardText(`${repoInfo.rootUrl}${p.path}@${selected.revision}`)}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              copy(`${repoInfo.rootUrl}${p.path}@${selected.revision}`, 'URL@revisión copiada')
                            }}
                          >
                            📋
                          </button>
                        )}
                        {canDiff && repoInfo && (() => {
                          const fileUrl = `${repoInfo.rootUrl}${p.path}@${selected.revision}`
                          const fileName = p.path.split('/').filter(Boolean).pop() || p.path
                          return (
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '0 5px', fontSize: 10, opacity: 0.6, flexShrink: 0 }}
                              title={`Descargar archivo\n${fileUrl}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                window.svn.downloadFile(fileUrl, fileName)
                                  .then((res: any) => {
                                    if (!res?.canceled) toast('Archivo descargado', 'success')
                                  })
                                  .catch((err: any) => toast(String(err?.message || err), 'error'))
                              }}
                            >
                              ⬇
                            </button>
                          )
                        })()}
                        {canDiff && <span className="history-path-diff-hint">{opensPreview ? (isWordFile(p.path) ? 'Ver Word →' : 'Ver PDF →') : 'Ver diff →'}</span>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div className="empty-state-title">Selecciona una revisión</div>
          </div>
        )}
      </div>
      {/* Historical file: Diff / Archivo completo */}
      <HistoricalFileDialog target={historicalFile.target} onClose={historicalFile.close} />
      <PdfPreviewDialog
        state={pdfPreview}
        onClose={() => setPdfPreview(null)}
      />
    </div>
  )
}
