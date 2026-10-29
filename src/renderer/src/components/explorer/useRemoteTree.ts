import { useCallback, useEffect, useRef, useState } from 'react'
import type { Credentials, RemoteEntry, RemoteServer } from '../../types/svn'
import { isAuthError, normalizeError, type EntrySortMode } from './explorerUtils'
import { getSvnApi, type ToastFn } from './shared'

interface ServerNavState {
  tree: RemoteEntry[]
  expandedUrls: Set<string>
  childrenCache: Record<string, RemoteEntry[]>
}

function withItem(set: Set<string>, key: string): Set<string> {
  const next = new Set(set)
  next.add(key)
  return next
}

function withoutItem(set: Set<string>, key: string): Set<string> {
  const next = new Set(set)
  next.delete(key)
  return next
}

const waitForNextPaint = () => new Promise<void>((resolve) => {
  window.requestAnimationFrame(() => resolve())
})

/**
 * Remote tree navigation: root listing, lazy children, sorting, per-server
 * navigation cache, and focusing a search result inside the tree.
 */
export function useRemoteTree(options: {
  credentials: Credentials | null
  activeRemote: RemoteServer | null
  onRequestCredentials: (serverUrl?: string, authError?: boolean) => void
  toast: ToastFn
  /** Called when the active server changes (e.g. to close an open menu). */
  onServerChanged?: () => void
}) {
  const { credentials, activeRemote, onRequestCredentials, toast, onServerChanged } = options
  const [serverUrl, setServerUrl] = useState('')
  const [tree, setTree] = useState<RemoteEntry[]>([])
  const [sortMode, setSortMode] = useState<EntrySortMode>('revision')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedUrls, setExpandedUrls] = useState<Set<string>>(new Set())
  const [childrenCache, setChildrenCache] = useState<Record<string, RemoteEntry[]>>({})
  const [loadingChildrenUrls, setLoadingChildrenUrls] = useState<Set<string>>(new Set())
  const [highlightedEntryUrl, setHighlightedEntryUrl] = useState<string | null>(null)

  const treeEntryRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const childrenCacheRef = useRef<Record<string, RemoteEntry[]>>(childrenCache)
  const expandedUrlsRef = useRef<Set<string>>(expandedUrls)
  const highlightTimeoutRef = useRef<number | null>(null)
  const serverStateCache = useRef<Record<string, ServerNavState>>({})
  const prevRemoteId = useRef<string | null>(null)

  useEffect(() => { childrenCacheRef.current = childrenCache }, [childrenCache])
  useEffect(() => { expandedUrlsRef.current = expandedUrls }, [expandedUrls])
  useEffect(() => () => {
    if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current)
  }, [])

  useEffect(() => {
    const init = async () => {
      try {
        const url = activeRemote?.url || await getSvnApi().getServerUrl()
        if (url) setServerUrl(url)
      } catch (err: any) {
        setError(err.message || 'No se pudo inicializar el Explorador SVN')
      }
    }
    void init()
  }, [])

  // Save/restore navigation per server when the active remote changes.
  useEffect(() => {
    if (!activeRemote?.id) return
    const prevId = prevRemoteId.current
    if (prevId && prevId !== activeRemote.id) {
      serverStateCache.current[prevId] = { tree, expandedUrls, childrenCache }
    }
    const cached = serverStateCache.current[activeRemote.id]
    setTree(cached ? cached.tree : [])
    setExpandedUrls(cached ? cached.expandedUrls : new Set())
    setChildrenCache(cached ? cached.childrenCache : {})
    setLoadingChildrenUrls(new Set())
    setError(null)
    setServerUrl(activeRemote.url)
    onServerChanged?.()
    prevRemoteId.current = activeRemote.id
  }, [activeRemote?.id])

  const handleSortClick = useCallback((mode: EntrySortMode) => {
    if (mode === sortMode) {
      setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortMode(mode)
      setSortDir('desc')
    }
  }, [sortMode])

  const loadRoot = async () => {
    const nextUrl = serverUrl.trim()
    if (!nextUrl) {
      toast('Ingresa una URL de servidor SVN', 'error')
      return
    }
    if (!credentials) {
      onRequestCredentials(nextUrl)
      return
    }

    setLoading(true)
    setError(null)
    onServerChanged?.()
    try {
      const svn = getSvnApi()
      await svn.setServerUrl(nextUrl)
      const entries = await svn.listRemote(nextUrl)
      setTree(entries)
      setExpandedUrls(new Set())
      setChildrenCache({})
      setLoadingChildrenUrls(new Set())
    } catch (err: any) {
      setError(normalizeError(err) || 'Error al conectar con el servidor SVN')
      if (isAuthError(err)) onRequestCredentials(nextUrl, true)
    } finally {
      setLoading(false)
    }
  }

  const refreshChildren = async (parentUrl: string) => {
    setLoadingChildrenUrls((prev) => withItem(prev, parentUrl))
    setExpandedUrls((prev) => withItem(prev, parentUrl))
    try {
      const children = await getSvnApi().listRemote(parentUrl)
      setChildrenCache((prev) => ({ ...prev, [parentUrl]: children }))
    } catch (err: any) {
      if (isAuthError(err)) onRequestCredentials(parentUrl, true)
      throw err
    } finally {
      setLoadingChildrenUrls((prev) => withoutItem(prev, parentUrl))
    }
  }

  /** After creating an item under `parentUrl`, refresh the root or that folder. */
  const refreshAfterCreate = async (parentUrl: string) => {
    if (tree.some((x) => x.url === parentUrl)) await loadRoot()
    else await refreshChildren(parentUrl)
  }

  const toggleExpand = async (entry: RemoteEntry) => {
    if (entry.kind !== 'dir') return
    const key = entry.url
    if (loadingChildrenUrls.has(key)) return

    if (expandedUrls.has(key)) {
      setExpandedUrls((prev) => withoutItem(prev, key))
      return
    }

    // Update URL bar to reflect current navigation position
    setServerUrl(entry.url)
    setExpandedUrls((prev) => withItem(prev, key))
    if (key in childrenCache) return

    setLoadingChildrenUrls((prev) => withItem(prev, key))
    try {
      const children = await getSvnApi().listRemote(entry.url)
      setChildrenCache((prev) => ({ ...prev, [key]: children }))
    } catch (err: any) {
      if (isAuthError(err)) onRequestCredentials(entry.url, true)
      else toast('Error al cargar contenido: ' + normalizeError(err), 'error')
      setExpandedUrls((prev) => withoutItem(prev, key))
    } finally {
      setLoadingChildrenUrls((prev) => withoutItem(prev, key))
    }
  }

  const ensureChildrenLoaded = async (parentUrl: string) => {
    const wasExpanded = expandedUrlsRef.current.has(parentUrl)
    setExpandedUrls((prev) => withItem(prev, parentUrl))

    if (Object.prototype.hasOwnProperty.call(childrenCacheRef.current, parentUrl)) {
      await waitForNextPaint()
      return
    }

    setLoadingChildrenUrls((prev) => withItem(prev, parentUrl))
    try {
      const children = await getSvnApi().listRemote(parentUrl)
      childrenCacheRef.current = { ...childrenCacheRef.current, [parentUrl]: children }
      setChildrenCache((prev) => ({ ...prev, [parentUrl]: children }))
      await waitForNextPaint()
    } catch (err) {
      if (isAuthError(err)) onRequestCredentials(parentUrl, true)
      if (!wasExpanded) setExpandedUrls((prev) => withoutItem(prev, parentUrl))
      throw err
    } finally {
      setLoadingChildrenUrls((prev) => withoutItem(prev, parentUrl))
    }
  }

  const focusTreeEntry = async (entryUrl: string) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await waitForNextPaint()
      const node = treeEntryRefs.current[entryUrl]
      if (!node) continue

      node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
      setHighlightedEntryUrl(entryUrl)
      if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current)
      highlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedEntryUrl((prev) => (prev === entryUrl ? null : prev))
      }, 2600)
      return true
    }
    return false
  }

  const registerNode = useCallback((url: string, node: HTMLDivElement | null) => {
    treeEntryRefs.current[url] = node
  }, [])

  return {
    serverUrl,
    setServerUrl,
    tree,
    loading,
    error,
    sortMode,
    sortDir,
    handleSortClick,
    expandedUrls,
    childrenCache,
    loadingChildrenUrls,
    highlightedEntryUrl,
    loadRoot,
    refreshAfterCreate,
    toggleExpand,
    ensureChildrenLoaded,
    focusTreeEntry,
    registerNode
  }
}
