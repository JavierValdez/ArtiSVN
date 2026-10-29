/**
 * Incremental scanner for `svn list --xml --depth infinity` output.
 *
 * svn emits one `<entry kind="dir|file"><name>relative/path</name>…</entry>`
 * per node. The scanner keeps only the unfinished tail of the stream, so memory
 * stays bounded regardless of the size of the listing, and it refuses to buffer
 * more than `maxPendingChars` of an unterminated entry (malformed/hostile XML).
 */

export interface ListXmlEntry {
  kind: 'dir' | 'file'
  /** Path relative to the listed URL, `/`-separated, entities decoded. */
  path: string
}

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXmlText(value: string): string {
  return value.replace(ENTITY_RE, (_match, entity: string) => {
    if (entity[0] !== '#') return NAMED[entity]
    const code = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

export class ListXmlScanner {
  private buffer = ''
  private sourceTail = ''
  private documentClosed = false
  private readonly maxPendingChars: number

  constructor(options: { maxPendingChars?: number } = {}) {
    this.maxPendingChars = options.maxPendingChars ?? 1024 * 1024
  }

  /** Feeds decoded text; returns the entries completed by this chunk. */
  push(text: string): ListXmlEntry[] {
    const boundary = this.sourceTail + text
    if (boundary.includes('</lists>')) this.documentClosed = true
    this.sourceTail = boundary.slice(-16)
    this.buffer += text
    const entries: ListXmlEntry[] = []
    for (;;) {
      const start = this.buffer.indexOf('<entry')
      if (start < 0) {
        // Keep a short tail in case "<entry" is split across chunks.
        this.buffer = this.buffer.slice(-8)
        break
      }
      const end = this.buffer.indexOf('</entry>', start)
      if (end < 0) {
        this.buffer = this.buffer.slice(start)
        if (this.buffer.length > this.maxPendingChars) {
          throw new Error('XML de svn list inválido: entrada sin cerrar demasiado grande')
        }
        break
      }
      const block = this.buffer.slice(start, end)
      this.buffer = this.buffer.slice(end + '</entry>'.length)
      const kind = /\bkind="(dir|file)"/.exec(block)?.[1]
      const name = /<name>([\s\S]*?)<\/name>/.exec(block)?.[1]
      if ((kind !== 'dir' && kind !== 'file') || name === undefined) throw new Error('XML de svn list inválido: entrada incompleta')
      entries.push({ kind, path: decodeXmlText(name) })
    }
    return entries
  }

  end(): void {
    if (!this.documentClosed || this.buffer.includes('<entry')) throw new Error('XML de svn list incompleto')
    this.buffer = ''
  }
}

/** Minimal log parser: revision + message of each `<logentry>`. */
export function parseLogXmlMessages(xml: string): Array<{ revision: number; message: string }> {
  const out: Array<{ revision: number; message: string }> = []
  for (const match of xml.matchAll(/<logentry\s+revision="(\d+)"\s*>([\s\S]*?)<\/logentry>/g)) {
    const msg = /<msg>([\s\S]*?)<\/msg>/.exec(match[2])?.[1]
    out.push({ revision: Number(match[1]), message: msg === undefined ? '' : decodeXmlText(msg) })
  }
  return out
}
