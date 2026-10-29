import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xml2js = _require('xml2js') as any

/**
 * Pure helpers (no Electron imports). ArtiSVN always runs checkout/update/export/switch with `--ignore-externals`
 * (see svn-policy.ts). These helpers only *inform* the user that external
 * definitions exist and were not fetched; they never fetch them.
 */

export const EXTERNALS_NOTICE_PREFIX = 'Aviso: '

/** Counts external definitions in `svn propget svn:externals -R --xml` output. */
export async function countExternalDefinitions(xml: string): Promise<number> {
  if (!xml.trim()) return 0
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: true })
  let count = 0
  for (const target of parsed?.properties?.target || []) {
    for (const property of target?.property || []) {
      const value = typeof property === 'string' ? property : String(property?._ || '')
      count += value
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter((line: string) => line && !line.startsWith('#')).length
    }
  }
  return count
}

export function buildExternalsNotice(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  const what = count === 1
    ? '1 definición svn:externals que no se descargó'
    : `${count} definiciones svn:externals que no se descargaron`
  return `${EXTERNALS_NOTICE_PREFIX}esta copia contiene ${what}. ` +
    'ArtiSVN no descarga externals automáticamente; si necesitas uno, haz checkout de su URL por separado.'
}

/** Generic notice for exports (the remote tree is not inspected again). */
export const EXPORT_EXTERNALS_NOTICE =
  `${EXTERNALS_NOTICE_PREFIX}la exportación no incluye svn:externals. Si necesitas uno, expórtalo por separado desde su URL.`
