import { useCallback, useState } from 'react'
import type { RemoteEntry } from '../../types/svn'
import type { PdfPreviewState } from '../PdfPreviewDialog'
import { isPreviewableFile, isWordFile } from '../../utils/fileTypes'
import { normalizeError } from './explorerUtils'
import { BINARY_EXTENSIONS, getSvnApi } from './shared'

export interface FileViewerState {
  open: boolean
  url: string
  name: string
  content: string | null
  loading: boolean
  error: string | null
}

const CLOSED_VIEWER: FileViewerState = { open: false, url: '', name: '', content: null, loading: false, error: null }

/**
 * Remote file preview: text viewer for plain files and the shared PDF/DOCX
 * preview dialog (also used for documents at a historical revision).
 */
export function useRemotePreview() {
  const [fileViewer, setFileViewer] = useState<FileViewerState>(CLOSED_VIEWER)
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewState | null>(null)

  const loadDocumentPreview = useCallback(async (url: string, fileName: string, base: PdfPreviewState) => {
    setPdfPreview(base)
    try {
      const preview = await getSvnApi().getRemotePreviewFile(url, fileName)
      setPdfPreview((prev) => prev ? { ...prev, title: preview.name, base64: preview.base64, loading: false } : prev)
    } catch (err: any) {
      setPdfPreview((prev) => prev ? { ...prev, loading: false, error: normalizeError(err) || 'Error al abrir el archivo' } : prev)
    }
  }, [])

  const openFileViewer = useCallback(async (entry: RemoteEntry) => {
    const ext = entry.name.split('.').pop()?.toLowerCase() || ''
    if (isPreviewableFile(entry.name)) {
      setFileViewer(CLOSED_VIEWER)
      await loadDocumentPreview(entry.url, entry.name, {
        title: entry.name,
        subtitle: entry.url,
        base64: null,
        loading: true,
        error: null,
        fileType: isWordFile(entry.name) ? 'word' : 'pdf'
      })
      return
    }
    if (BINARY_EXTENSIONS.has(ext)) {
      setFileViewer({ open: true, url: entry.url, name: entry.name, content: null, loading: false, error: `No se puede previsualizar archivos binarios (.${ext})` })
      return
    }
    setFileViewer({ open: true, url: entry.url, name: entry.name, content: null, loading: true, error: null })
    try {
      const content = await getSvnApi().remoteFileContent(entry.url)
      setFileViewer((prev) => ({ ...prev, content, loading: false }))
    } catch (err: any) {
      setFileViewer((prev) => ({ ...prev, loading: false, error: normalizeError(err) || 'Error al obtener el archivo' }))
    }
  }, [loadDocumentPreview])

  /** PDF/DOCX of `svnPath` at `revision`, resolved against the repository root. */
  const openRevisionPreview = useCallback(async (repoRoot: string, contextTitle: string, svnPath: string, revision: number) => {
    const fileName = svnPath.split('/').filter(Boolean).pop() || svnPath
    await loadDocumentPreview(`${repoRoot}${svnPath}@${revision}`, fileName, {
      title: fileName,
      subtitle: `${contextTitle} · ${svnPath}`,
      base64: null,
      loading: true,
      error: null,
      badge: `r${revision}`,
      fileType: isWordFile(fileName) ? 'word' : 'pdf'
    })
  }, [loadDocumentPreview])

  const closeFileViewer = useCallback(() => setFileViewer((prev) => ({ ...prev, open: false })), [])
  const closePdfPreview = useCallback(() => setPdfPreview(null), [])

  return { fileViewer, pdfPreview, openFileViewer, openRevisionPreview, closeFileViewer, closePdfPreview }
}
