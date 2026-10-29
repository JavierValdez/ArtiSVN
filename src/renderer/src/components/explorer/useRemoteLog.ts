import { useCallback, useState } from 'react'
import type { LogEntry, RemoteEntry } from '../../types/svn'
import { normalizeError } from './explorerUtils'
import { getSvnApi, type ToastFn } from './shared'
import { useHistoricalFileTarget } from '../history/HistoricalFileDialog'

export interface RemoteLogState {
  open: boolean
  url: string
  title: string
  loading: boolean
  entries: LogEntry[]
  selected: LogEntry | null
  repoRoot: string | null
}

export const CLOSED_REMOTE_LOG: RemoteLogState = {
  open: false,
  url: '',
  title: '',
  loading: false,
  entries: [],
  selected: null,
  repoRoot: null
}

/** Remote history dialog state, per-file diff at a revision and document preview at a revision. */
export function useRemoteLog(
  toast: ToastFn,
  openRevisionPreview: (repoRoot: string, contextTitle: string, svnPath: string, revision: number) => Promise<void>
) {
  const [remoteLog, setRemoteLog] = useState<RemoteLogState>(CLOSED_REMOTE_LOG)
  const historicalFile = useHistoricalFileTarget()

  /** Opens the history of `entry`; optionally pre-selects `selectRevision` once loaded. */
  const openRemoteLog = useCallback(async (entry: RemoteEntry, selectRevision?: number) => {
    const title = entry.name.replace(/\/$/, '') || entry.url
    setRemoteLog({ ...CLOSED_REMOTE_LOG, open: true, url: entry.url, title, loading: true })

    try {
      const svn = getSvnApi()
      const [entries, repoRoot] = await Promise.all([
        svn.remoteLog(entry.url, 100),
        svn.getRepoRoot(entry.url).catch(() => null)
      ])
      const preferred = selectRevision
        ? (entries as LogEntry[]).find((logEntry) => logEntry.revision === selectRevision)
        : undefined
      setRemoteLog((prev) => ({
        ...prev,
        loading: false,
        entries,
        selected: preferred || (entries.length > 0 ? entries[0] : null),
        repoRoot
      }))
    } catch (err: any) {
      setRemoteLog((prev) => ({ ...prev, loading: false }))
      toast(normalizeError(err) || 'Error al cargar log remoto', 'error')
    }
  }, [toast])

  const selectLogEntry = useCallback((entry: LogEntry) => {
    setRemoteLog((prev) => ({ ...prev, selected: entry }))
  }, [])

  const closeRemoteLog = useCallback(() => {
    historicalFile.close()
    setRemoteLog(CLOSED_REMOTE_LOG)
  }, [historicalFile.close])

  /** Opens the shared Diff / Archivo completo modal, bound to this history's URL and revision. */
  const openRemoteFileDiff = useCallback((svnPath: string, revision: number) => {
    const baseUrl = remoteLog.url
    const parts = svnPath.split('/')
    historicalFile.open({
      svnPath,
      fileName: parts[parts.length - 1] || svnPath,
      revision,
      loadDiff: () => getSvnApi().remoteRevisionDiff(baseUrl, svnPath, revision),
      loadSnapshot: () => getSvnApi().remoteRevisionFileContent(baseUrl, svnPath, revision)
    })
  }, [historicalFile.open, remoteLog.url])

  const openRemotePdfRevision = useCallback(async (svnPath: string, revision: number) => {
    if (!remoteLog.repoRoot) {
      toast('No se pudo obtener la URL base para previsualizar el PDF', 'error')
      return
    }
    await openRevisionPreview(remoteLog.repoRoot, remoteLog.title, svnPath, revision)
  }, [openRevisionPreview, remoteLog.repoRoot, remoteLog.title, toast])

  return {
    remoteLog,
    historicalFile: historicalFile.target,
    openRemoteLog,
    selectLogEntry,
    closeRemoteLog,
    openRemoteFileDiff,
    openRemotePdfRevision,
    closeHistoricalFile: historicalFile.close
  }
}
