import type { RemoteEntry } from '../../types/svn'
import { formatDateShort, sortEntries, type EntrySortMode } from './explorerUtils'
import { getFileIcon } from './shared'

/** Everything a tree row needs; shared by all rows (passed down recursively). */
export interface RemoteTreeContext {
  expandedUrls: Set<string>
  childrenCache: Record<string, RemoteEntry[]>
  loadingChildrenUrls: Set<string>
  highlightedEntryUrl: string | null
  menuEntryUrl: string | null
  sortMode: EntrySortMode
  sortDir: 'asc' | 'desc'
  onToggle: (entry: RemoteEntry) => void
  onOpenFile: (entry: RemoteEntry) => void
  onMenuButton: (entry: RemoteEntry, button: HTMLButtonElement) => void
  onCloseMenu: () => void
  registerNode: (url: string, node: HTMLDivElement | null) => void
}

const SKELETON_WIDTHS = [58, 42, 70, 35]

function ChildrenSkeleton() {
  return (
    <>
      {SKELETON_WIDTHS.map((w, i) => (
        <div key={i} className="tree-skeleton-row">
          <div className="tree-skeleton-chevron" />
          <div className="tree-skeleton-icon" />
          <div className="tree-skeleton-body">
            <div className="tree-skeleton-line wide" style={{ width: `${w}%` }} />
            <div className={`tree-skeleton-line ${i % 2 === 0 ? 'medium' : 'narrow'}`} />
          </div>
        </div>
      ))}
    </>
  )
}

function ExpandIcon({ expanded, loading, onClick }: { expanded: boolean; loading: boolean; onClick: () => void }) {
  return (
    <span
      className={`expand-icon ${expanded ? 'expanded' : ''} ${loading ? 'loading' : ''}`}
      onClick={onClick}
      style={{ cursor: loading ? 'wait' : 'pointer' }}
    >
      {loading ? (
        <span className="spinner tree-expand-spinner" />
      ) : (
        <svg className="tree-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  )
}

export function RemoteTreeEntry({ entry, depth, ctx }: { entry: RemoteEntry; depth: number; ctx: RemoteTreeContext }) {
  const isDir = entry.kind === 'dir'
  const isExpanded = ctx.expandedUrls.has(entry.url)
  const isMenuOpen = ctx.menuEntryUrl === entry.url
  const children = ctx.childrenCache[entry.url]
  const isLoadingChildren = ctx.loadingChildrenUrls.has(entry.url)
  const hasLoadedChildren = Object.prototype.hasOwnProperty.call(ctx.childrenCache, entry.url)
  const activate = () => (isDir ? ctx.onToggle(entry) : ctx.onOpenFile(entry))
  const cursor = isLoadingChildren ? 'wait' : 'pointer'

  return (
    <div
      className={`tree-entry-row ${isMenuOpen ? 'menu-open' : ''} ${ctx.highlightedEntryUrl === entry.url ? 'search-target' : ''}`}
      ref={(node) => ctx.registerNode(entry.url, node)}
    >
      <div
        className={`tree-item ${isExpanded ? 'expanded' : ''} ${isLoadingChildren ? 'loading' : ''} ${isMenuOpen ? 'menu-open' : ''}`}
        style={{ paddingLeft: 16 + depth * 20 }}
      >
        {isDir
          ? <ExpandIcon expanded={isExpanded} loading={isLoadingChildren} onClick={() => ctx.onToggle(entry)} />
          : <span className="expand-icon placeholder" />}

        <span className="tree-item-icon" onClick={activate} style={{ cursor }}>
          {isDir ? (isExpanded ? '📂' : '📁') : getFileIcon(entry.name)}
        </span>

        <div className="tree-item-body" onClick={activate} style={{ cursor }}>
          <span className="tree-item-name">{entry.name.replace(/\/$/, '')}</span>
          {(entry.author || entry.isCheckedOut) && (
            <div className="tree-item-subtitle">
              {entry.author && <span className="tree-item-author-text">{entry.author}</span>}
              {entry.isCheckedOut && <span className="tree-item-checked">✓ Local</span>}
            </div>
          )}
        </div>

        <span className="tree-item-date-col">{formatDateShort(entry.date)}</span>
        <span className="tree-item-meta">r{entry.revision}</span>

        <div className="tree-item-actions">
          <button
            className="tree-menu-btn"
            title="Opciones"
            onClick={(e) => {
              e.stopPropagation()
              if (isMenuOpen) ctx.onCloseMenu()
              else ctx.onMenuButton(entry, e.currentTarget)
            }}
          >
            ···
          </button>
        </div>
      </div>

      {isExpanded && (isLoadingChildren || hasLoadedChildren) && (
        <div className="tree-children">
          {isLoadingChildren ? (
            <ChildrenSkeleton />
          ) : children.length === 0 ? (
            <div style={{ padding: '4px 16px', fontSize: 12, color: 'var(--text3)' }}>
              (directorio vacío)
            </div>
          ) : (
            sortEntries(children, ctx.sortMode, ctx.sortDir).map((child) => (
              <RemoteTreeEntry key={child.url} entry={child} depth={depth + 1} ctx={ctx} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function SortableColumnHeaders({ sortMode, sortDir, onSort }: {
  sortMode: EntrySortMode
  sortDir: 'asc' | 'desc'
  onSort: (mode: EntrySortMode) => void
}) {
  const arrow = (mode: EntrySortMode) => (sortMode === mode ? (sortDir === 'desc' ? '▼' : '▲') : '⇅')
  return (
    <div className="explorer-col-header">
      <button className={`explorer-col-name explorer-col-btn${sortMode === 'name' ? ' active' : ''}`} onClick={() => onSort('name')}>
        Nombre {arrow('name')}
      </button>
      <button className={`explorer-col-btn${sortMode === 'date' ? ' active' : ''}`} onClick={() => onSort('date')}>
        Fecha {arrow('date')}
      </button>
      <button className={`explorer-col-btn${sortMode === 'revision' ? ' active' : ''}`} onClick={() => onSort('revision')}>
        Revisión {arrow('revision')}
      </button>
      <div className="explorer-col-actions" />
    </div>
  )
}
