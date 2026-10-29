import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

interface Props {
  base64: string
}

export default function PdfViewer({ base64 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.25)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)

  // Load PDF document
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }

    pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise
      .then((doc) => {
        if (cancelled) {
          doc.destroy()
          return
        }
        setPdf(doc)
        setNumPages(doc.numPages)
        setPageNumber(1)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message || 'No se pudo cargar el PDF')
        setLoading(false)
      })

    return () => {
      cancelled = true
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
        renderTaskRef.current = null
      }
      setPdf((prev) => {
        if (prev) prev.destroy()
        return null
      })
    }
  }, [base64])

  // Render page
  useEffect(() => {
    if (!pdf || !canvasRef.current) return

    let cancelled = false

    const render = async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled) {
          page.cleanup()
          return
        }

        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current!
        const context = canvas.getContext('2d')!

        canvas.width = viewport.width
        canvas.height = viewport.height

        // Clear previous render
        context.clearRect(0, 0, canvas.width, canvas.height)

        if (renderTaskRef.current) {
          renderTaskRef.current.cancel()
        }

        const task = page.render({ canvasContext: context, viewport })
        renderTaskRef.current = task

        await task.promise
        if (!cancelled) {
          renderTaskRef.current = null
        }
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException' || err?.message?.includes('cancelled')) {
          return
        }
        if (!cancelled) {
          setError(err?.message || 'Error al renderizar la página')
        }
      }
    }

    render()

    return () => {
      cancelled = true
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
        renderTaskRef.current = null
      }
    }
  }, [pdf, pageNumber, scale])

  const goToPage = useCallback((n: number) => {
    if (n < 1 || n > numPages) return
    setPageNumber(n)
  }, [numPages])

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(s + 0.25, 3))
  }, [])

  const zoomOut = useCallback(() => {
    setScale((s) => Math.max(s - 0.25, 0.5))
  }, [])

  const zoomFit = useCallback(() => {
    if (!containerRef.current || !pdf) return
    const containerWidth = containerRef.current.clientWidth - 48
    pdf.getPage(pageNumber).then((page) => {
      const vp = page.getViewport({ scale: 1 })
      const fitScale = containerWidth / vp.width
      setScale(Math.max(0.5, Math.min(fitScale, 2.5)))
    })
  }, [pdf, pageNumber])

  if (loading) {
    return (
      <div className="pdf-viewer-container">
        <div className="pdf-viewer-placeholder">
          <div className="spinner spinner-lg" />
          <span style={{ color: 'var(--text2)', marginTop: 12 }}>Cargando PDF...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="pdf-viewer-container">
        <div className="pdf-viewer-placeholder pdf-preview-error">
          <span style={{ fontSize: 32 }}>⚠️</span>
          <span>{error}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="pdf-viewer-wrapper">
      <div className="pdf-viewer-toolbar">
        <div className="pdf-toolbar-group">
          <button
            className="pdf-toolbar-btn"
            onClick={() => goToPage(pageNumber - 1)}
            disabled={pageNumber <= 1}
            title="Página anterior"
          >
            ←
          </button>
          <span className="pdf-page-info">
            <input
              type="number"
              min={1}
              max={numPages}
              value={pageNumber}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                if (!isNaN(n)) goToPage(n)
              }}
              className="pdf-page-input"
            />
            <span className="pdf-page-total">/ {numPages}</span>
          </span>
          <button
            className="pdf-toolbar-btn"
            onClick={() => goToPage(pageNumber + 1)}
            disabled={pageNumber >= numPages}
            title="Página siguiente"
          >
            →
          </button>
        </div>

        <div className="pdf-toolbar-group">
          <button className="pdf-toolbar-btn" onClick={zoomOut} title="Alejar">−</button>
          <span className="pdf-zoom-level">{Math.round(scale * 100)}%</span>
          <button className="pdf-toolbar-btn" onClick={zoomIn} title="Acercar">+</button>
          <button className="pdf-toolbar-btn" onClick={zoomFit} title="Ajustar a ventana">⟲</button>
        </div>
      </div>

      <div className="pdf-viewer-container" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className="pdf-viewer-canvas"
          style={{
            transform: `scale(${1})`,
            transformOrigin: 'top center'
          }}
        />
      </div>
    </div>
  )
}
