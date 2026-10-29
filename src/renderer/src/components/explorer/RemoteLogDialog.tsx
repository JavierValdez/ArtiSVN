import type { LogEntry } from '../../types/svn'
import { formatClipboardText } from '../../utils/clipboard'
import { isPreviewableFile, isWordFile } from '../../utils/fileTypes'
import { formatDate, getRemoteLogScopePath, isPathWithinRemoteLogScope, normalizeError } from './explorerUtils'
import { ACTION_LABEL, copyToClipboard, getSvnApi, type ToastFn } from './shared'
import type { RemoteLogState } from './useRemoteLog'

interface Props {
  remoteLog: RemoteLogState
  onSelect: (entry: LogEntry) => void
  onClose: () => void
  onOpenFileDiff: (svnPath: string, revision: number) => void
  onOpenDocumentPreview: (svnPath: string, revision: number) => void
  toast: ToastFn
}

function RemoteLogEntryList({ remoteLog, onSelect, toast }: Pick<Props, 'remoteLog' | 'onSelect' | 'toast'>) {
  if (remoteLog.loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
        <div className="spinner spinner-lg" />
      </div>
    )
  }
  if (remoteLog.entries.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📋</div>
        <div className="empty-state-title">Sin historial</div>
      </div>
    )
  }
  return (
    <>
      {remoteLog.entries.map((entry) => (
        <div
          key={entry.revision}
          className={`history-item ${remoteLog.selected?.revision === entry.revision ? 'selected' : ''}`}
          onClick={() => onSelect(entry)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="history-rev">r{entry.revision}</div>
            <button
              className="btn btn-ghost"
              style={{ padding: '0 4px', fontSize: 10, lineHeight: 1.4, opacity: 0.55 }}
              title="Copiar revisión"
              onClick={(e) => {
                e.stopPropagation()
                copyToClipboard(String(entry.revision), 'Revisión copiada', toast)
              }}
            >
              📋
            </button>
          </div>
          <div className="history-msg">{entry.message || '(sin mensaje)'}</div>
          <div className="history-meta">
            {entry.author} · {formatDate(entry.date)}
          </div>
        </div>
      ))}
    </>
  )
}

interface ChangedPathProps {
  path: { path: string; action: string }
  selected: LogEntry
  repoRoot: string | null
  scopePath: string | null
  onOpenFileDiff: Props['onOpenFileDiff']
  onOpenDocumentPreview: Props['onOpenDocumentPreview']
  toast: ToastFn
}

function RemoteLogChangedPath({ path: p, selected, repoRoot, scopePath, onOpenFileDiff, onOpenDocumentPreview, toast }: ChangedPathProps) {
  const canDiff = p.action !== 'D'
  const opensPreview = canDiff && isPreviewableFile(p.path)
  const isInScope = isPathWithinRemoteLogScope(p.path, scopePath)
  const revisionUrl = repoRoot ? `${repoRoot}${p.path}@${selected.revision}` : null
  const fileName = p.path.split('/').filter(Boolean).pop() || p.path

  return (
    <div
      className={`history-path-item ${canDiff ? 'history-path-item-clickable' : ''} ${!isInScope ? 'history-path-item-outside' : ''}`}
      onClick={() => canDiff && (opensPreview
        ? onOpenDocumentPreview(p.path, selected.revision)
        : onOpenFileDiff(p.path, selected.revision))}
      title={!isInScope
        ? 'Cambio fuera de la carpeta a la que hiciste show log'
        : canDiff ? (opensPreview ? 'Ver documento de esta revisión' : 'Ver diff de este archivo') : ''}
    >
      <span title={p.action}>{ACTION_LABEL[p.action] || p.action}</span>
      <span className="history-remote-path" style={{ flex: 1 }}>{p.path}</span>
      {!isInScope && <span className="history-path-scope-badge">Fuera</span>}
      <button
        className="btn btn-ghost"
        style={{ padding: '0 5px', fontSize: 10, opacity: 0.6, flexShrink: 0 }}
        title={revisionUrl
          ? `Copiar URL@revisión\n${formatClipboardText(revisionUrl)}`
          : `Copiar ruta\n${formatClipboardText(p.path)}`}
        onClick={(e) => {
          e.stopPropagation()
          copyToClipboard(revisionUrl || p.path, revisionUrl ? 'URL@revisión copiada' : 'Ruta copiada', toast)
        }}
      >
        📋
      </button>
      {canDiff && revisionUrl && (
        <button
          className="btn btn-ghost"
          style={{ padding: '0 5px', fontSize: 10, opacity: 0.6, flexShrink: 0 }}
          title={`Descargar archivo\n${revisionUrl}`}
          onClick={(e) => {
            e.stopPropagation()
            getSvnApi().downloadFile(revisionUrl, fileName)
              .then((res: any) => {
                if (!res?.canceled) toast('Archivo descargado', 'success')
              })
              .catch((err: any) => toast(normalizeError(err), 'error'))
          }}
        >
          ⬇
        </button>
      )}
      {canDiff && (
        <span className="history-path-diff-hint">
          {opensPreview ? (isWordFile(p.path) ? 'Ver Word →' : 'Ver PDF →') : 'Ver diff →'}
        </span>
      )}
    </div>
  )
}

function RemoteLogDetail({ remoteLog, onOpenFileDiff, onOpenDocumentPreview, toast }: Omit<Props, 'onSelect' | 'onClose'>) {
  const selected = remoteLog.selected
  if (!selected) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📋</div>
        <div className="empty-state-title">Selecciona una revisión</div>
      </div>
    )
  }

  const scopePath = getRemoteLogScopePath(remoteLog.repoRoot, remoteLog.url)
  const hasOutOfScopePaths = selected.paths.some((p) => !isPathWithinRemoteLogScope(p.path, scopePath))

  return (
    <>
      <div className="history-detail-rev" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>Revisión {selected.revision}</span>
        <button
          className="btn btn-ghost"
          style={{ padding: '1px 7px', fontSize: 11 }}
          title="Copiar número de revisión"
          onClick={() => copyToClipboard(String(selected.revision), 'Revisión copiada', toast)}
        >
          📋 r{selected.revision}
        </button>
        <button
          className="btn btn-ghost"
          style={{ padding: '1px 7px', fontSize: 11 }}
          title={`Copiar URL@revisión\n${formatClipboardText(`${remoteLog.url}@${selected.revision}`)}`}
          onClick={() => copyToClipboard(`${remoteLog.url}@${selected.revision}`, 'URL@revisión copiada', toast)}
        >
          📋 URL
        </button>
      </div>
      <div className="history-detail-author">
        👤 {selected.author} · 🕐 {formatDate(selected.date)}
      </div>
      <div className="history-detail-msg">
        {selected.message || '(sin mensaje de commit)'}
      </div>

      {selected.paths.length > 0 && (
        <>
          <div className="history-paths-title">
            Cambios ({selected.paths.length})
            {hasOutOfScopePaths && (
              <span className="history-paths-note">Atenuado = fuera de esta carpeta</span>
            )}
          </div>
          {selected.paths.map((p, i) => (
            <RemoteLogChangedPath
              key={i}
              path={p}
              selected={selected}
              repoRoot={remoteLog.repoRoot}
              scopePath={scopePath}
              onOpenFileDiff={onOpenFileDiff}
              onOpenDocumentPreview={onOpenDocumentPreview}
              toast={toast}
            />
          ))}
        </>
      )}
    </>
  )
}

export default function RemoteLogDialog(props: Props) {
  const { remoteLog, onClose } = props
  if (!remoteLog.open) return null

  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 980, maxWidth: '92vw' }}>
        <div className="dialog-title">🕘 Historial remoto</div>
        <div className="dialog-sub" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {remoteLog.title} · {remoteLog.url}
        </div>

        <div
          className="history-layout"
          style={{ height: 460, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}
        >
          <div className="history-list">
            <RemoteLogEntryList remoteLog={remoteLog} onSelect={props.onSelect} toast={props.toast} />
          </div>
          <div className="history-detail">
            <RemoteLogDetail
              remoteLog={remoteLog}
              onOpenFileDiff={props.onOpenFileDiff}
              onOpenDocumentPreview={props.onOpenDocumentPreview}
              toast={props.toast}
            />
          </div>
        </div>

        <div className="dialog-actions">
          <button className="btn btn-default" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
