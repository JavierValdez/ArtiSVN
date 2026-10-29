import { useCallback, useState } from 'react'
import type { RemoteEntry } from '../../types/svn'
import { describeSkippedExternals } from '../../utils/externals'
import { normalizeError } from './explorerUtils'
import { getSvnApi, type ToastFn } from './shared'

export interface CheckoutState {
  url: string
  name: string
  running: boolean
  log: string
  done: boolean
}

export interface CheckoutResult {
  skippedInvalidCount?: number
  skippedInvalidPaths?: string[]
  skippedExternalsCount?: number
}

export interface ExportState {
  url: string
  targetDir: string
  name: string
  running: boolean
  log: string
  done: boolean
  resultPath: string
}

function defaultNameFromUrl(url: string, fallback: string): string {
  const nameParts = url.split('/')
  return nameParts[nameParts.length - 1].replace(/\/$/, '') || fallback
}

export function isInvalidLocalName(name: string): boolean {
  return name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(name)
}

/** Checkout (working copy) and export (plain copy) dialogs' state and actions. */
export function useCheckoutExport(options: {
  toast: ToastFn
  /** Called after a successful checkout (parent refreshes repos). */
  onCheckoutDone: () => void
  /** Called shortly after a successful checkout, when the dialog closes (tree refresh). */
  onCheckoutClosed: () => void
}) {
  const { toast, onCheckoutDone, onCheckoutClosed } = options
  const [checkout, setCheckout] = useState<CheckoutState | null>(null)
  const [svnExportDialog, setSvnExportDialog] = useState<ExportState | null>(null)

  const startCheckout = useCallback((entry: RemoteEntry) => {
    setCheckout({ url: entry.url, name: defaultNameFromUrl(entry.url, 'repo'), running: false, log: '', done: false })
  }, [])

  const setCheckoutName = useCallback((name: string) => {
    setCheckout((prev) => prev ? { ...prev, name } : null)
  }, [])

  const closeCheckout = useCallback(() => setCheckout(null), [])

  const doCheckout = useCallback(async () => {
    if (!checkout) return
    const checkoutName = checkout.name.trim()
    if (!checkoutName) {
      toast('Escribe un nombre para el directorio local', 'error')
      return
    }
    if (isInvalidLocalName(checkoutName)) {
      toast('El nombre del directorio local contiene caracteres no permitidos', 'error')
      return
    }

    setCheckout((prev) => prev ? { ...prev, running: true, log: '' } : null)
    let unsub = () => {}
    try {
      const svn = getSvnApi()
      unsub = svn.onCheckoutProgress((msg: string) => {
        setCheckout((prev) => prev ? { ...prev, log: prev.log + msg } : null)
      })
      const result = await svn.checkout(checkout.url, checkoutName) as CheckoutResult
      const skippedInvalidCount = Number(result?.skippedInvalidCount || 0)
      if (skippedInvalidCount > 0) {
        const skippedPreview = result.skippedInvalidPaths?.slice(0, 3).join('\n') || ''
        setCheckout((prev) => prev
          ? {
            ...prev,
            log: `${prev.log}\nClonación parcial: ${skippedInvalidCount} entradas omitidas por nombres no válidos en este sistema.${skippedPreview ? `\n${skippedPreview}` : ''}`
          }
          : null
        )
      }
      setCheckout((prev) => prev ? { ...prev, running: false, done: true } : null)
      toast(
        skippedInvalidCount > 0
          ? `Clonado parcial: ${skippedInvalidCount} entradas omitidas por nombres no válidos`
          : 'Repositorio clonado correctamente',
        skippedInvalidCount > 0 ? 'info' : 'success'
      )
      // The dialog closes automatically: keep the externals notice visible as a toast.
      const externalsNote = describeSkippedExternals(result?.skippedExternalsCount)
      if (externalsNote) toast(externalsNote, 'info')
      onCheckoutDone()
      setTimeout(() => {
        onCheckoutClosed()
        setCheckout(null)
      }, 1500)
    } catch (err: any) {
      setCheckout((prev) => prev ? { ...prev, running: false } : null)
      toast(normalizeError(err) || 'Error al clonar el repositorio', 'error')
    } finally {
      unsub()
    }
  }, [checkout, onCheckoutClosed, onCheckoutDone, toast])

  const startExport = useCallback((entry: RemoteEntry) => {
    setSvnExportDialog({
      url: entry.url,
      targetDir: '',
      name: defaultNameFromUrl(entry.url, 'exportacion'),
      running: false,
      log: '',
      done: false,
      resultPath: ''
    })
  }, [])

  const setExportName = useCallback((name: string) => {
    setSvnExportDialog((prev) => prev ? { ...prev, name } : null)
  }, [])

  const pickExportFolder = useCallback(async () => {
    const dir = await getSvnApi().pickExportFolder()
    if (dir) setSvnExportDialog((prev) => prev ? { ...prev, targetDir: dir } : null)
  }, [])

  const closeExport = useCallback(() => setSvnExportDialog(null), [])

  const doExport = useCallback(async () => {
    if (!svnExportDialog) return
    if (!svnExportDialog.targetDir) { toast('Selecciona una carpeta de destino', 'error'); return }
    if (!svnExportDialog.name.trim()) { toast('Escribe un nombre para la carpeta', 'error'); return }
    const targetPath = `${svnExportDialog.targetDir}/${svnExportDialog.name.trim()}`
    setSvnExportDialog((prev) => prev ? { ...prev, running: true, log: '', resultPath: targetPath } : null)
    let unsub = () => {}
    try {
      const svn = getSvnApi()
      unsub = svn.onExportProgress((msg: string) => {
        setSvnExportDialog((prev) => prev ? { ...prev, log: prev.log + msg } : null)
      })
      await svn.svnExport(svnExportDialog.url, targetPath)
      setSvnExportDialog((prev) => prev ? { ...prev, running: false, done: true } : null)
      toast('Exportación completada correctamente', 'success')
    } catch (err: any) {
      setSvnExportDialog((prev) => prev ? { ...prev, running: false } : null)
      toast(normalizeError(err) || 'Error al exportar', 'error')
    } finally {
      unsub()
    }
  }, [svnExportDialog, toast])

  return {
    checkout,
    startCheckout,
    setCheckoutName,
    closeCheckout,
    doCheckout,
    svnExportDialog,
    startExport,
    setExportName,
    pickExportFolder,
    closeExport,
    doExport
  }
}
