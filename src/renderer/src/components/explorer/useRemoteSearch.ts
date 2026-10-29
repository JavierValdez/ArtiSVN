import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteSearchResult } from '../../types/svn'
import { normalizeError } from './explorerUtils'

export type SearchStopReason = 'results' | 'dirs' | 'entries' | 'time' | 'bytes' | 'files' | 'cancelled'

export interface RemoteSearchDialogState {
  open: boolean
  url: string
  folderName: string
  query: string
  deepSearch: boolean
  running: boolean
  results: RemoteSearchResult[]
  searched: boolean
  error: string | null
  searchProgress: { searched: number; total: number; listingStats?: { dirs: number; entries: number } } | null
  stopReason: SearchStopReason | null
}

export function initialSearchState(): RemoteSearchDialogState {
  return {
    open: false,
    url: '',
    folderName: '',
    query: '',
    deepSearch: false,
    running: false,
    results: [],
    searched: false,
    error: null,
    searchProgress: null,
    stopReason: null
  }
}

/** User-facing explanation when the search did not cover everything. */
export function describeSearchStop(reason: SearchStopReason | null | undefined): string | null {
  switch (reason) {
    case 'results': return 'Se alcanzó el máximo de resultados; refina la búsqueda para ver más.'
    case 'dirs': return 'Búsqueda acotada: se alcanzó el límite de carpetas exploradas.'
    case 'entries': return 'Búsqueda acotada: se alcanzó el límite de entradas exploradas.'
    case 'time': return 'Búsqueda acotada: se alcanzó el tiempo máximo.'
    case 'bytes': return 'Búsqueda acotada: se alcanzó el volumen máximo de contenido leído.'
    case 'files': return 'Búsqueda acotada: demasiados archivos para revisar su contenido.'
    case 'cancelled': return 'Búsqueda detenida. Se muestran los resultados encontrados hasta ahora.'
    default: return null
  }
}

interface SearchApi {
  searchRemote: (url: string, query: string, deepSearch: boolean) => Promise<{ ok: boolean; truncated?: boolean; stopReason?: SearchStopReason }>
  cancelSearch?: () => Promise<boolean>
  onSearchResult: (cb: (result: RemoteSearchResult) => void) => () => void
  onSearchProgress: (cb: (data: any) => void) => () => void
  onSearchDone: (cb: (data: any) => void) => () => void
}

/** Remote search dialog state + progressive results + cancellation (extracted from ExplorerView). */
export function useRemoteSearch(
  getApi: () => SearchApi,
  toast: (msg: string, type?: 'success' | 'error' | 'info') => void
) {
  const [searchDialog, setSearchDialog] = useState<RemoteSearchDialogState>(initialSearchState)
  const unsubsRef = useRef<Array<() => void>>([])

  const detach = useCallback(() => {
    unsubsRef.current.forEach((fn) => fn())
    unsubsRef.current = []
  }, [])

  useEffect(() => detach, [detach])

  const openSearch = useCallback((entry: { url: string; name: string }) => {
    setSearchDialog({ ...initialSearchState(), open: true, url: entry.url, folderName: entry.name.replace(/\/$/, '') })
  }, [])

  const cancelSearch = useCallback(() => {
    void getApi().cancelSearch?.()
  }, [getApi])

  const runSearch = useCallback(async () => {
    const q = searchDialog.query.trim()
    if (!q) {
      toast('Escribe un término de búsqueda', 'error')
      return
    }

    detach()
    setSearchDialog((prev) => ({
      ...prev,
      running: true,
      results: [],
      searched: false,
      error: null,
      searchProgress: null,
      stopReason: null
    }))

    const api = getApi()
    unsubsRef.current = [
      api.onSearchResult((result) => {
        setSearchDialog((prev) => ({ ...prev, results: [...prev.results, result] }))
      }),
      api.onSearchProgress((data) => {
        setSearchDialog((prev) => ({ ...prev, searchProgress: data }))
      }),
      api.onSearchDone((data) => {
        setSearchDialog((prev) => ({ ...prev, searchProgress: data, stopReason: data?.stopReason ?? prev.stopReason }))
      })
    ]

    try {
      const response = await api.searchRemote(searchDialog.url, q, searchDialog.deepSearch)
      setSearchDialog((prev) => ({
        ...prev,
        running: false,
        searched: true,
        stopReason: response?.stopReason ?? prev.stopReason
      }))
    } catch (err: any) {
      setSearchDialog((prev) => ({
        ...prev,
        running: false,
        searched: true,
        error: normalizeError(err) || 'Error al buscar'
      }))
    } finally {
      detach()
    }
  }, [detach, getApi, searchDialog.deepSearch, searchDialog.query, searchDialog.url, toast])

  const closeSearch = useCallback(() => {
    if (searchDialog.running) void getApi().cancelSearch?.()
    detach()
    setSearchDialog(initialSearchState())
  }, [detach, getApi, searchDialog.running])

  return { searchDialog, setSearchDialog, openSearch, runSearch, cancelSearch, closeSearch }
}
