import { useState, useEffect, useRef, useId } from 'react'
import { EditorId, EditorOption, LocalRepo, RemoteServer } from '../types/svn'
import { describeRepoMeta, repoChangesBadge } from '../utils/repoMeta'
import { filterLocalRepos } from '../utils/repoFilter'
import appIcon from '../assets/icon.png'

interface Props {
  repos: LocalRepo[]
  remotes: RemoteServer[]
  selectedRepo: LocalRepo | null
  isExplorerActive: boolean
  activeRemoteId: string | null
  credentials: { username: string } | null
  onSelectRepo: (repo: LocalRepo) => void
  onSelectRemote: (remoteId: string) => void
  onAddRemote: () => void
  onRefresh: () => void
  onDeleteRepo: (repo: LocalRepo) => void
  onOpenFolder: (path: string) => void
  availableEditors: EditorOption[]
  onOpenInEditor: (editorId: EditorId, path: string) => void
  onDeleteRemote: (remote: RemoteServer) => void
  onRenameRemote: (remote: RemoteServer) => void
  onOpenProfile: () => void
  onOpenAgentIntegration: () => void
}

export default function Sidebar({
  repos,
  remotes,
  selectedRepo,
  isExplorerActive,
  activeRemoteId,
  credentials,
  onSelectRepo,
  onSelectRemote,
  onAddRemote,
  onRefresh,
  onDeleteRepo,
  onOpenFolder,
  availableEditors,
  onOpenInEditor,
  onDeleteRemote,
  onRenameRemote,
  onOpenProfile,
  onOpenAgentIntegration
}: Props) {
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [openRemoteMenuId, setOpenRemoteMenuId] = useState<string | null>(null)
  const remoteMenuRef = useRef<HTMLDivElement | null>(null)
  const [repoQuery, setRepoQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchId = useId()
  // Local-only view filter: never changes the repo list, the selection or the remotes.
  const visibleRepos = filterLocalRepos(repos, repoQuery)
  const isFiltering = repoQuery.trim().length > 0

  const updateRepoQuery = (value: string) => {
    setRepoQuery(value)
    setOpenMenuPath(null)
  }
  const clearRepoQuery = () => {
    updateRepoQuery('')
    searchInputRef.current?.focus()
  }

  useEffect(() => {
    if (!openMenuPath) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuPath(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openMenuPath])

  useEffect(() => {
    if (!openRemoteMenuId) return
    const handleClick = (e: MouseEvent) => {
      if (remoteMenuRef.current && !remoteMenuRef.current.contains(e.target as Node)) {
        setOpenRemoteMenuId(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openRemoteMenuId])

  return (
    <div className="sidebar">
      {/* Logo */}
      <div className="sidebar-header">
        <img src={appIcon} alt="ArtiSVN" className="sidebar-logo" />
        <div className="sidebar-appname">ArtiSVN</div>
      </div>

      {/* Repos section */}
      <div className="sidebar-section" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="sidebar-local-repos">
          {/* Sticky while scrolling the local list (stops before the remotes section). */}
          <div className="sidebar-local-head">
            <div className="sidebar-section-title">
              Repositorios locales
              <button
                className="btn btn-ghost"
                style={{ padding: '2px 6px', fontSize: 11, marginLeft: 4 }}
                onClick={onRefresh}
                title="Actualizar lista"
              >
                ⟳
              </button>
            </div>
            {repos.length > 0 && (
              <div className="sidebar-search" role="search">
                <label htmlFor={`${searchId}-input`} className="sr-only">Buscar repositorios locales</label>
                <span className="sidebar-search-icon" aria-hidden="true">⌕</span>
                <input
                  ref={searchInputRef}
                  id={`${searchId}-input`}
                  className="sidebar-search-input"
                  type="search"
                  value={repoQuery}
                  placeholder="Buscar repositorio…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={isFiltering ? `${searchId}-count` : undefined}
                  onChange={(e) => updateRepoQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && repoQuery) {
                      e.preventDefault()
                      clearRepoQuery()
                    }
                  }}
                />
                {repoQuery && (
                  <button
                    type="button"
                    className="sidebar-search-clear"
                    aria-label="Limpiar búsqueda"
                    title="Limpiar búsqueda (Esc)"
                    onClick={clearRepoQuery}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
            {isFiltering && repos.length > 0 && (
              <div id={`${searchId}-count`} className="sidebar-search-count" aria-live="polite">
                {visibleRepos.length} de {repos.length}
              </div>
            )}
          </div>

          {repos.length === 0 ? (
            <div style={{ padding: '12px', fontSize: 12, color: 'var(--sidebar-muted)', textAlign: 'center', lineHeight: 1.5 }}>
              Sin repositorios locales.{'\n'}Explora el servidor para clonar.
            </div>
          ) : visibleRepos.length === 0 ? (
            <div className="sidebar-search-empty" role="status">
              <div>Ningún repositorio coincide con «{repoQuery.trim()}».</div>
              <button type="button" className="sidebar-search-empty-btn" onClick={clearRepoQuery}>
                Limpiar búsqueda
              </button>
            </div>
          ) : (
          visibleRepos.map((repo) => (
            <div
              key={repo.path}
              className={`sidebar-item sidebar-item-with-menu ${selectedRepo?.path === repo.path ? 'active' : ''}`}
              onClick={() => { setOpenMenuPath(null); onSelectRepo(repo) }}
              style={{ position: 'relative' }}
            >
              <div className="sidebar-item-icon">📁</div>
              <div className="sidebar-item-info">
                <div className="sidebar-item-name">{repo.name}</div>
                <div
                  className="sidebar-item-sub"
                  title={repo.metadataState === 'error' ? repo.metadataError : undefined}
                >
                  {describeRepoMeta(repo)}
                </div>
              </div>
              {repoChangesBadge(repo) !== null && (
                <span className="sidebar-badge">{repoChangesBadge(repo)}</span>
              )}

              {/* Options button */}
              <button
                className="sidebar-item-menu-btn"
                title="Opciones"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenMenuPath(openMenuPath === repo.path ? null : repo.path)
                }}
              >
                ···
              </button>

              {/* Dropdown menu */}
              {openMenuPath === repo.path && (
                <div className="sidebar-item-dropdown" ref={menuRef}>
                  {availableEditors.map((editor) => (
                    <button
                      key={editor.id}
                      className="sidebar-dropdown-item"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenMenuPath(null)
                        onOpenInEditor(editor.id, repo.path)
                      }}
                    >
                      {editor.id === 'vscode-insiders' ? '🧪' : '🟦'} Abrir en {editor.label}
                    </button>
                  ))}
                  {availableEditors.length > 0 && <div className="sidebar-dropdown-divider" />}
                  <button
                    className="sidebar-dropdown-item"
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenuPath(null)
                      onOpenFolder(repo.path)
                    }}
                  >
                    📂 Abrir en Finder
                  </button>
                  <div className="sidebar-dropdown-divider" />
                  <button
                    className="sidebar-dropdown-item sidebar-dropdown-item-danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenuPath(null)
                      onDeleteRepo(repo)
                    }}
                  >
                    🗑 Eliminar copia local
                  </button>
                </div>
              )}
            </div>
          ))
          )}
        </div>

        <div className="sidebar-section-title" style={{ marginTop: 12 }}>
          Repositorios remotos
        </div>
        {remotes.length === 0 ? (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--sidebar-muted)' }}>
            Sin remotos guardados
          </div>
        ) : (
          remotes.map((remote) => (
            <div
              key={remote.id}
              className={`sidebar-item sidebar-item-with-menu ${(isExplorerActive && activeRemoteId === remote.id) ? 'active' : ''}`}
              onClick={() => { setOpenRemoteMenuId(null); onSelectRemote(remote.id) }}
              title={remote.url}
              style={{ position: 'relative' }}
            >
              <div className="sidebar-item-icon">🌐</div>
              <div className="sidebar-item-info">
                <div className="sidebar-item-name">{remote.name}</div>
                <div className="sidebar-item-sub">{remote.url}</div>
              </div>

              {/* Options button */}
              <button
                className="sidebar-item-menu-btn"
                title="Opciones"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenRemoteMenuId(openRemoteMenuId === remote.id ? null : remote.id)
                }}
              >
                ···
              </button>

              {/* Dropdown menu */}
              {openRemoteMenuId === remote.id && (
                <div className="sidebar-item-dropdown" ref={remoteMenuRef}>
                  <button
                    className="sidebar-dropdown-item"
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenRemoteMenuId(null)
                      onRenameRemote(remote)
                    }}
                  >
                    ✏️ Renombrar
                  </button>
                  <div className="sidebar-dropdown-divider" />
                  <button
                    className="sidebar-dropdown-item sidebar-dropdown-item-danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenRemoteMenuId(null)
                      onDeleteRemote(remote)
                    }}
                  >
                    🗑 Eliminar servidor
                  </button>
                </div>
              )}
            </div>
          ))
        )}
        <div
          className="sidebar-item"
          onClick={onAddRemote}
        >
          <div className="sidebar-item-icon">➕</div>
          <div className="sidebar-item-info">
            <div className="sidebar-item-name">Agregar servidor SVN</div>
            <div className="sidebar-item-sub">Conectar nueva URL</div>
          </div>
        </div>
      </div>

      {/* Profile footer */}
      <div className="sidebar-footer">
        <button
          className="sidebar-footer-btn"
          style={{
            marginBottom: 4
          }}
          onClick={onOpenAgentIntegration}
          title="Integración IA"
        >
          <span>◎</span>
          <span>Integración IA</span>
        </button>
        {credentials?.username ? (
          <button
            className="sidebar-footer-btn"
            onClick={onOpenProfile}
            title="Cambiar usuario o contrasena"
          >
            <span>👤</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {credentials.username}
            </span>
          </button>
        ) : (
          <button
            className="sidebar-footer-btn muted"
            onClick={onOpenProfile}
          >
            <span>⚠️</span>
            <span>Sin credenciales</span>
          </button>
        )}
      </div>

    </div>
  )
}
