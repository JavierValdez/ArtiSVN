import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Fix originally added for Electron 32: `import __cjs_mod__ from 'node:module'` failed
// because node:module had no default export in Electron's ESM loader.
// Replace with namespace import which exposes named exports. Kept on Electron 44:
// the namespace form is equivalent and harmless (verified with `npm run build` + app start).
function fixCjsShimPlugin() {
  return {
    name: 'fix-cjs-shim',
    generateBundle(_: any, bundle: any) {
      for (const chunk of Object.values(bundle) as any[]) {
        if (chunk.type === 'chunk' && chunk.code) {
          // Replace default import with namespace import
          chunk.code = chunk.code.replace(
            `import __cjs_mod__ from "node:module";`,
            `import * as __cjs_mod__ from "node:module";`
          )
        }
      }
    }
  }
}

/**
 * Content-Security-Policy for the packaged renderer (file://). Only injected in
 * production builds: the Vite dev server needs inline HMR/react-refresh scripts.
 * - style 'unsafe-inline': docx-preview injects <style> elements.
 * - blob:/data: images & fonts: docx/pdf previews.
 * - worker 'self': pdf.js worker bundled as an asset.
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function productionCspPlugin() {
  return {
    name: 'artisvn-production-csp',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), fixCjsShimPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin(), fixCjsShimPlugin()],
    // Sandboxed preload scripts must be CommonJS. (Cast: electron-vite 5 types
    // reference Vite 6 build options while this project pins Vite 5.)
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    } as any
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), productionCspPlugin()],
    optimizeDeps: {
      include: ['jszip']
    }
  }
})
