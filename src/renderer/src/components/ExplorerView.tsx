import { useCallback } from 'react'
import { Credentials, RemoteEntry, RemoteSearchResult, RemoteServer } from '../types/svn'
import PdfPreviewDialog from './PdfPreviewDialog'
import { getSearchExpansionTrail, normalizeError, sortEntries } from './explorer/explorerUtils'
import { copyToClipboard, getSvnApi } from './explorer/shared'
import { useRemoteSearch } from './explorer/useRemoteSearch'
import { useRemoteTree } from './explorer/useRemoteTree'
import { useRemotePreview } from './explorer/useRemotePreview'
import { useRemoteLog } from './explorer/useRemoteLog'
import { useCheckoutExport } from './explorer/useCheckoutExport'
import { CreateRemoteDialog, SaveRemoteDialog, useRemoteWriteDialogs } from './explorer/RemoteWriteDialogs'
import { RemoteEntryMenu, useEntryMenu, type EntryMenuActions } from './explorer/RemoteEntryMenu'
import { RemoteTreeEntry, SortableColumnHeaders, type RemoteTreeContext } from './explorer/RemoteTree'
import RemoteLogDialog from './explorer/RemoteLogDialog'
import RemoteSearchDialog from './explorer/RemoteSearchDialog'
import { CheckoutDialog, ExportDialog } from './explorer/CheckoutExportDialogs'
import { FileViewerDialog } from './explorer/RemoteViewerDialogs'
import HistoricalFileDialog from './history/HistoricalFileDialog'

interface Props {
  credentials: Credentials | null
  activeRemote: RemoteServer | null
  onSaveRemote: (name: string, url: string) => Promise<void>
  onCheckoutDone: () => void
  onRequestCredentials: (serverUrl?: string, authError?: boolean) => void
  onLogout: () => Promise<void>
  toast: (msg: string, type?: 'success' | 'error' | 'info') => void
}

/**
 * Remote SVN explorer. Orchestrates the tree and its dialogs; state and actions
 * live in hooks under ./explorer and every dialog is its own component.
 */
export default function ExplorerView({
  credentials,
  activeRemote,
  onSaveRemote,
  onCheckoutDone,
  onRequestCredentials,
  onLogout,
  toast
}: Props) {
  const menu = useEntryMenu()
  const treeState = useRemoteTree({ credentials, activeRemote, onRequestCredentials, toast, onServerChanged: menu.closeMenu })
  const search = useRemoteSearch(getSvnApi, toast)
  const preview = useRemotePreview()
  const history = useRemoteLog(toast, preview.openRevisionPreview)
  const transfer = useCheckoutExport({ toast, onCheckoutDone, onCheckoutClosed: () => { void treeState.loadRoot() } })
  const writes = useRemoteWriteDialogs({ toast, onSaveRemote, onRemoteCreated: treeState.refreshAfterCreate })

  const handleSearchResultSelect = async (result: RemoteSearchResult) => {
    const searchBaseUrl = search.searchDialog.url
    const searchFolderName = search.searchDialog.folderName
    search.closeSearch()

    if (result.kind === 'revision') {
      const pseudoEntry: RemoteEntry = {
        name: searchFolderName || searchBaseUrl.split('/').pop() || searchBaseUrl,
        url: searchBaseUrl,
        kind: 'dir',
        revision: result.revision || 0,
        author: '',
        date: '',
        isCheckedOut: false
      }
      await history.openRemoteLog(pseudoEntry, result.revision)
      return
    }

    try {
      const foldersToExpand = getSearchExpansionTrail(searchBaseUrl, result.entryUrl)
      if (!foldersToExpand) {
        toast('El resultado no pertenece a la rama cargada en el árbol', 'error')
        return
      }
      for (const folderUrl of foldersToExpand) {
        await treeState.ensureChildrenLoaded(folderUrl)
      }
      const focusContextUrl = result.kind === 'dir'
        ? result.entryUrl
        : foldersToExpand[foldersToExpand.length - 1] || searchBaseUrl
      treeState.setServerUrl(focusContextUrl)
      if (!(await treeState.focusTreeEntry(result.entryUrl))) {
        toast('No se pudo centrar el resultado en el árbol', 'error')
      }
    } catch (err: any) {
      toast(normalizeError(err) || 'Error al navegar al resultado', 'error')
    }
  }

  const downloadFile = useCallback((entry: RemoteEntry) => {
    getSvnApi().downloadFile(entry.url, entry.name)
      .then((res: any) => {
        if (!res?.canceled) toast('Archivo descargado', 'success')
      })
      .catch((err: any) => toast(normalizeError(err), 'error'))
  }, [toast])

  const menuActions: EntryMenuActions = {
    openLog: (entry) => { void history.openRemoteLog(entry) },
    copy: (text, label) => copyToClipboard(text, label, toast),
    download: downloadFile,
    view: (entry) => { void preview.openFileViewer(entry) },
    checkout: transfer.startCheckout,
    exportCopy: transfer.startExport,
    create: writes.openCreateRemote,
    search: search.openSearch
  }

  const treeContext: RemoteTreeContext = {
    expandedUrls: treeState.expandedUrls,
    childrenCache: treeState.childrenCache,
    loadingChildrenUrls: treeState.loadingChildrenUrls,
    highlightedEntryUrl: treeState.highlightedEntryUrl,
    menuEntryUrl: menu.entryMenu?.entry.url ?? null,
    sortMode: treeState.sortMode,
    sortDir: treeState.sortDir,
    onToggle: (entry) => { void treeState.toggleExpand(entry) },
    onOpenFile: (entry) => { void preview.openFileViewer(entry) },
    onMenuButton: menu.openAtButton,
    onCloseMenu: menu.closeMenu,
    registerNode: treeState.registerNode
  }

  const { serverUrl, tree, loading, error } = treeState

  return (
    <div className="explorer-layout">
      {/* Toolbar */}
      <div className="explorer-toolbar">
        <span className="explorer-toolbar-title">🌐 Servidor SVN</span>
        <input
          className="form-input explorer-url-input"
          value={serverUrl}
          onChange={(e) => treeState.setServerUrl(e.target.value)}
          placeholder="https://servidor/svn"
          title="URL del servidor SVN"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void treeState.loadRoot()
            }
          }}
        />
        <button className="btn btn-default" onClick={() => writes.openSaveRemote(serverUrl)} disabled={loading}>
          Guardar URL
        </button>
        {!credentials ? (
          <button className="btn btn-ghost explorer-toolbar-warning" onClick={() => onRequestCredentials(serverUrl)}>
            ⚠️ Sin credenciales
          </button>
        ) : (
          <>
            <span className="explorer-toolbar-user">👤 {credentials.username}</span>
            <button className="btn btn-ghost" onClick={onLogout} title="Cerrar sesión y cambiar cuenta">
              Cerrar sesión
            </button>
          </>
        )}
        <button className="btn btn-primary" onClick={() => void treeState.loadRoot()} disabled={loading}>
          {loading ? '⟳ Cargando...' : '⟳ Conectar'}
        </button>
      </div>

      {tree.length > 0 && (
        <SortableColumnHeaders sortMode={treeState.sortMode} sortDir={treeState.sortDir} onSort={treeState.handleSortClick} />
      )}

      {/* Tree */}
      <div className="explorer-tree">
        {loading && tree.length === 0 ? (
          <div className="empty-state">
            <div className="spinner spinner-lg" />
            <div className="empty-state-sub">Conectando al servidor SVN...</div>
          </div>
        ) : error ? (
          <div className="empty-state">
            <div className="empty-state-icon">⚠️</div>
            <div className="empty-state-title">Error de conexión</div>
            <div className="empty-state-sub" style={{ color: 'var(--danger)' }}>{error}</div>
            <div className="empty-state-sub" style={{ marginTop: 8 }}>
              Verifica que estés en la red interna y que las credenciales sean correctas
            </div>
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => void treeState.loadRoot()}>
              Reintentar
            </button>
          </div>
        ) : tree.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <div className="empty-state-title">Explorar repositorios SVN</div>
            <div className="empty-state-sub">
              Conéctate al servidor para ver los repositorios disponibles
            </div>
            {!credentials && (
              <button className="btn btn-default" style={{ marginTop: 8 }} onClick={() => onRequestCredentials(serverUrl)}>
                Configurar credenciales
              </button>
            )}
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => void treeState.loadRoot()}>
              Conectar al servidor
            </button>
          </div>
        ) : (
          sortEntries(tree, treeState.sortMode, treeState.sortDir).map((entry) => (
            <RemoteTreeEntry key={entry.url} entry={entry} depth={0} ctx={treeContext} />
          ))
        )}
      </div>

      <RemoteEntryMenu menu={menu.entryMenu} menuRef={menu.menuRef} onClose={menu.closeMenu} actions={menuActions} />

      <SaveRemoteDialog
        state={writes.saveRemoteDialog}
        onChange={writes.updateSaveRemote}
        onClose={writes.closeSaveRemote}
        onSubmit={() => void writes.submitSaveRemote()}
      />

      <RemoteLogDialog
        remoteLog={history.remoteLog}
        onSelect={history.selectLogEntry}
        onClose={history.closeRemoteLog}
        onOpenFileDiff={history.openRemoteFileDiff}
        onOpenDocumentPreview={(svnPath, revision) => void history.openRemotePdfRevision(svnPath, revision)}
        toast={toast}
      />

      <CreateRemoteDialog
        state={writes.createRemote}
        onChange={writes.updateCreateRemote}
        onClose={writes.closeCreateRemote}
        onSubmit={() => void writes.submitCreateRemote()}
      />

      <RemoteSearchDialog
        state={search.searchDialog}
        onQueryChange={(query) => search.setSearchDialog((prev) => ({ ...prev, query }))}
        onDeepSearchChange={(deepSearch) => search.setSearchDialog((prev) => ({ ...prev, deepSearch }))}
        onRun={() => void search.runSearch()}
        onCancel={search.cancelSearch}
        onClose={search.closeSearch}
        onSelectResult={(result) => { void handleSearchResultSelect(result) }}
      />

      <CheckoutDialog
        state={transfer.checkout}
        onNameChange={transfer.setCheckoutName}
        onClose={transfer.closeCheckout}
        onConfirm={() => void transfer.doCheckout()}
      />

      <ExportDialog
        state={transfer.svnExportDialog}
        onNameChange={transfer.setExportName}
        onPickFolder={() => void transfer.pickExportFolder()}
        onOpenResult={(path) => getSvnApi().openFolder(path)}
        onClose={transfer.closeExport}
        onConfirm={() => void transfer.doExport()}
      />

      <HistoricalFileDialog target={history.historicalFile} onClose={history.closeHistoricalFile} />

      <FileViewerDialog state={preview.fileViewer} onClose={preview.closeFileViewer} toast={toast} />

      <PdfPreviewDialog state={preview.pdfPreview} onClose={preview.closePdfPreview} />
    </div>
  )
}
