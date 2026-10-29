/**
 * Short user-facing text when a checkout/update left svn:externals out.
 * ArtiSVN never fetches externals automatically; the full notice is in the progress log.
 */
export function describeSkippedExternals(count: unknown): string | null {
  const n = Number(count || 0)
  if (!Number.isFinite(n) || n <= 0) return null
  return n === 1
    ? 'Se omitió 1 svn:external. Descárgalo por separado desde su URL si lo necesitas.'
    : `Se omitieron ${n} svn:externals. Descárgalos por separado desde su URL si los necesitas.`
}
