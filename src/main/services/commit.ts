import { createRequire } from 'node:module'
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { normalizeRelativePath } from './read-contract'
import { resolvePhysicalRepoTarget } from './path-guard'

const _require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xml2js = _require('xml2js') as any

/**
 * Strict commit / revert of a user selection.
 *
 * SVN operations are recursive by default. Passing a directory to
 * `svn commit` would publish every changed descendant, including siblings the
 * user did not select. This service:
 *  - validates every path (lexical + physical containment, no root escapes),
 *  - adds selected unversioned items with `--depth empty --parents`,
 *  - adds required newly-added ancestors as non-recursive targets,
 *  - commits with `--depth empty` unless a selected directory deletion/replace
 *    needs recursion, and in that case refuses if unselected changes would ride along,
 *  - separates options from targets (`--targets` file) so names starting with
 *    `-` are never parsed as options,
 *  - rolls back the `svn add` it performed if the commit fails.
 */

export type SvnRunner = (
  args: string[],
  options: { cwd: string; timeoutMs?: number }
) => Promise<{ stdout: string; stderr?: string }>

export interface StatusItem {
  item: string
  props: string
  /** Original (case-preserving) repo-relative path. */
  path: string
}

export type StatusMap = Map<string, StatusItem>

const UNCHANGED_ITEMS = new Set(['normal', 'none', 'unversioned', 'ignored', 'external'])

export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = normalizeRelativePath(path) || '.'
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function isChanged(status: StatusItem | undefined): boolean {
  if (!status) return false
  if (!UNCHANGED_ITEMS.has(status.item)) return true
  return status.item === 'normal' && (status.props === 'modified' || status.props === 'conflicted')
}

export async function parseStatusXml(xml: string): Promise<StatusMap> {
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, mergeAttrs: false })
  const map: StatusMap = new Map()
  const rawTargets = parsed?.status?.target
  const targets = Array.isArray(rawTargets) ? rawTargets : rawTargets ? [rawTargets] : []
  for (const target of targets) {
    const rawEntries = target?.entry
    const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : []
    for (const entry of entries) {
      const path = normalizeRelativePath(String(entry?.$?.path || '.')) || '.'
      const wc = entry?.['wc-status']?.$ || {}
      map.set(pathKey(path), { item: String(wc.item || 'normal'), props: String(wc.props || 'none'), path })
    }
  }
  return map
}

function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const result: string[] = []
  for (let i = parts.length - 1; i >= 1; i -= 1) result.push(parts.slice(0, i).join('/'))
  return result
}

function isDescendant(ancestor: string, path: string): boolean {
  if (ancestor === '.') return path !== '.'
  return path.startsWith(`${ancestor}/`)
}

function depthOf(path: string): number {
  return path === '.' ? 0 : path.split('/').length
}

/** Validates and normalizes the selection; returns repo-relative posix paths. */
export function normalizeSelection(repoPath: string, files: unknown): string[] {
  if (!Array.isArray(files)) throw new Error('La selección de archivos es inválida')
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of files) {
    if (typeof raw !== 'string') throw new Error('La selección de archivos es inválida')
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (/[\r\n\u0000]/.test(trimmed)) throw new Error('Ruta con caracteres no válidos en la selección')
    if (posix.isAbsolute(trimmed.replace(/\\/g, '/')) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
      throw new Error('La selección solo admite rutas relativas al repositorio')
    }
    const normalized = normalizeRelativePath(trimmed) || '.'
    if (normalized.split('/').some((segment) => segment === '..')) {
      throw new Error('Ruta fuera del repositorio')
    }
    if (normalized.split('/').some((segment) => segment === '.svn')) {
      throw new Error('No se pueden seleccionar metadatos .svn')
    }
    // Physical containment: parents must not traverse symlinks/junctions out of the repo.
    resolvePhysicalRepoTarget(repoPath, normalized, { allowSymlinkLeaf: true })
    const key = pathKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  if (result.length === 0) throw new Error('Selecciona al menos un archivo')
  return result
}

function isRealDirectory(repoPath: string, relPath: string): boolean {
  try {
    const stat = lstatSync(join(repoPath, ...relPath.split('/').filter(Boolean)))
    return stat.isDirectory()
  } catch {
    return false
  }
}

function existsOnDisk(repoPath: string, relPath: string): boolean {
  try {
    lstatSync(join(repoPath, ...relPath.split('/').filter(Boolean)))
    return true
  } catch {
    return false
  }
}

function withTargetsFile<T>(paths: string[], task: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'artisvn-targets-'))
  const file = join(dir, 'targets.txt')
  writeFileSync(file, `${paths.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
  return task(file).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

async function readKinds(run: SvnRunner, repoPath: string, paths: string[]): Promise<Map<string, 'dir' | 'file'>> {
  const kinds = new Map<string, 'dir' | 'file'>()
  for (const path of paths) {
    if (existsOnDisk(repoPath, path)) {
      kinds.set(path, isRealDirectory(repoPath, path) ? 'dir' : 'file')
      continue
    }
    try {
      const { stdout } = await run(['info', '--show-item', 'kind', '--no-newline', '--', path], { cwd: repoPath, timeoutMs: 15_000 })
      kinds.set(path, stdout.trim() === 'dir' ? 'dir' : 'file')
    } catch {
      kinds.set(path, 'file')
    }
  }
  return kinds
}

async function readStatus(run: SvnRunner, repoPath: string): Promise<StatusMap> {
  const { stdout } = await run(['status', '--xml', '--depth', 'infinity'], { cwd: repoPath, timeoutMs: 120_000 })
  return parseStatusXml(stdout)
}

export interface CommitPlan {
  targets: string[]
  depth: 'empty' | 'infinity'
  /** Changed items that the commit will publish. */
  effective: string[]
}

/**
 * Pure planning step (exported for tests). Given the status after preparation,
 * returns the targets/depth or throws if the selection cannot be committed strictly.
 */
export function planStrictCommit(
  selected: string[],
  status: StatusMap,
  kinds: Map<string, 'dir' | 'file'>
): CommitPlan {
  const targetSet = new Map<string, string>()
  for (const path of selected) targetSet.set(pathKey(path), path)

  // Newly added (or replaced) ancestors must be part of the commit, non-recursively.
  for (const path of selected) {
    for (const ancestor of ancestorsOf(path)) {
      const st = status.get(pathKey(ancestor))
      if (st && (st.item === 'added' || st.item === 'replaced')) targetSet.set(pathKey(ancestor), ancestor)
    }
  }

  const targets = Array.from(targetSet.values()).sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b))
  const recursiveDirs = targets.filter((path) => {
    const st = status.get(pathKey(path))
    return kinds.get(path) === 'dir' && st && (st.item === 'deleted' || st.item === 'replaced') && selected.includes(path)
  })
  const depth: 'empty' | 'infinity' = recursiveDirs.length > 0 ? 'infinity' : 'empty'

  const changedPaths = Array.from(status.entries())
    .filter(([, st]) => isChanged(st))
    .map(([key]) => key)
  const displayPath = (key: string) => status.get(key)?.path || key

  const targetKeys = targets.map((path) => pathKey(path))
  const effective = depth === 'empty'
    ? changedPaths.filter((key) => targetKeys.includes(key))
    : changedPaths.filter((key) => targetKeys.some((target) => key === target || isDescendant(target, key)))

  const allowed = new Set(targetKeys)
  const implied = recursiveDirs.map((path) => pathKey(path))
  const unexpected = effective.filter((key) => !allowed.has(key) && !implied.some((dir) => isDescendant(dir, key)))
  if (unexpected.length > 0) {
    const sample = unexpected.slice(0, 5).map(displayPath).join(', ')
    throw new Error(
      `El commit incluiría cambios no seleccionados (${sample}${unexpected.length > 5 ? ', …' : ''}). ` +
      'Selecciónalos también o haz commit de la carpeta eliminada por separado.'
    )
  }

  const nothing = effective.length === 0
  if (nothing) throw new Error('La selección no contiene cambios para hacer commit')

  return { targets, depth, effective: effective.map(displayPath) }
}

export interface CommitResult {
  success: true
  output: string
  targets: string[]
  depth: 'empty' | 'infinity'
}

export async function commitSelectedPaths(
  repoPath: string,
  files: unknown,
  message: unknown,
  run: SvnRunner
): Promise<CommitResult> {
  const safeMessage = typeof message === 'string' ? message.trim() : ''
  if (!safeMessage) throw new Error('El mensaje de commit es requerido')
  const selected = normalizeSelection(repoPath, files)

  const before = await readStatus(run, repoPath)

  const missing = selected.filter((path) => before.get(pathKey(path))?.item === 'missing')
  if (missing.length > 0) {
    await withTargetsFile(missing, (file) => run(['delete', '--force', '--targets', file], { cwd: repoPath, timeoutMs: 120_000 }))
  }

  // Unversioned selections, and items inside unversioned directories (not reported by status).
  const toAdd = selected
    .filter((path) => {
      const st = before.get(pathKey(path))
      if (st) return st.item === 'unversioned'
      return path !== '.' && existsOnDisk(repoPath, path)
    })
    .sort((a, b) => depthOf(a) - depthOf(b))

  const rollbackAdds = async () => {
    if (toAdd.length === 0) return
    // Revert our adds deepest-first; files stay on disk as unversioned.
    const addedNow = await readStatus(run, repoPath).catch(() => new Map() as StatusMap)
    const toRevert = Array.from(addedNow.entries())
      .filter(([key, st]) => st.item === 'added' && before.get(key)?.item !== 'added' && toAdd.some((added) => {
        const addedKey = pathKey(added)
        // the added item itself or a parent created by --parents
        return key === addedKey || isDescendant(key, addedKey)
      }))
      .map(([, st]) => st.path)
      .sort((a, b) => depthOf(b) - depthOf(a))
    for (const path of toRevert) {
      try {
        await run(['revert', '--depth', 'empty', '--', path], { cwd: repoPath, timeoutMs: 60_000 })
      } catch {
        // best effort
      }
    }
  }

  if (toAdd.length > 0) {
    try {
      await withTargetsFile(toAdd, (file) => run(
        ['add', '--force', '--parents', '--depth', 'empty', '--targets', file],
        { cwd: repoPath, timeoutMs: 120_000 }
      ))
    } catch (error) {
      await rollbackAdds()
      throw error
    }
  }


  let plan: CommitPlan
  try {
    const after = await readStatus(run, repoPath)
    const kinds = await readKinds(run, repoPath, selected)
    plan = planStrictCommit(selected, after, kinds)
  } catch (error) {
    await rollbackAdds()
    throw error
  }

  try {
    const { stdout } = await withTargetsFile(plan.targets, (file) => run(
      ['commit', '--depth', plan.depth, '--force-log', '-m', safeMessage, '--targets', file],
      { cwd: repoPath }
    ))
    return { success: true, output: stdout, targets: plan.targets, depth: plan.depth }
  } catch (error) {
    await rollbackAdds()
    const base = error instanceof Error ? error.message : 'Error al hacer commit'
    const note = missing.length > 0
      ? '\n(Los archivos faltantes quedaron marcados para eliminación.)'
      : ''
    throw new Error(`${base}${note}`)
  }
}

export interface RevertResult {
  success: true
  output: string
}

/**
 * Reverts exactly the selection. Directories are reverted non-recursively,
 * except added/deleted/replaced directories (which SVN can only revert
 * recursively); those are refused if an unselected descendant has local
 * content changes that would be lost.
 */
export async function revertSelectedPaths(
  repoPath: string,
  files: unknown,
  run: SvnRunner
): Promise<RevertResult> {
  const selected = normalizeSelection(repoPath, files)
  const status = await readStatus(run, repoPath)
  const kinds = await readKinds(run, repoPath, selected)
  const selectedKeys = new Set(selected.map((path) => pathKey(path)))

  const recursive: string[] = []
  const flat: string[] = []
  for (const path of selected) {
    const st = status.get(pathKey(path))
    const structural = st && (st.item === 'added' || st.item === 'deleted' || st.item === 'replaced')
    if (kinds.get(path) === 'dir' && structural) recursive.push(path)
    else flat.push(path)
  }

  for (const dir of recursive) {
    const dirKey = pathKey(dir)
    const lost = Array.from(status.entries()).filter(([key, st]) => (
      isDescendant(dirKey, key)
      && !selectedKeys.has(key)
      && isChanged(st)
    ))
    if (lost.length > 0) {
      throw new Error(
        `Revertir "${dir}" descartaría cambios no seleccionados (${lost.slice(0, 5).map(([, st]) => st.path).join(', ')}).`
      )
    }
  }

  const outputs: string[] = []
  if (flat.length > 0) {
    // Deepest first, so non-recursive reverts of added parents do not fail on added children.
    const ordered = [...flat].sort((a, b) => depthOf(b) - depthOf(a))
    const { stdout } = await withTargetsFile(ordered, (file) => run(
      ['revert', '--depth', 'empty', '--targets', file],
      { cwd: repoPath, timeoutMs: 120_000 }
    ))
    outputs.push(stdout)
  }
  if (recursive.length > 0) {
    const { stdout } = await withTargetsFile(recursive, (file) => run(
      ['revert', '--depth', 'infinity', '--targets', file],
      { cwd: repoPath, timeoutMs: 120_000 }
    ))
    outputs.push(stdout)
  }
  return { success: true, output: outputs.join('') }
}
