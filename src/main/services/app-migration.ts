import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { type LocalPathOptions, type LocalPaths, resolveLocalPaths } from './local-paths'

export type MigrationAction = 'migrate-now' | 'remind-later' | 'start-without-migration'
export type MigrationStatus = 'pending' | 'in-progress' | 'completed' | 'blocked' | 'failed' | 'skipped'
export type MigrationItemStatus = 'pending' | 'copying' | 'completed' | 'not-found' | 'conflict' | 'failed'

export interface MigrationFileSystem {
  existsSync: typeof existsSync
  readFileSync: typeof readFileSync
  writeFileSync: typeof writeFileSync
  mkdirSync: typeof mkdirSync
  readdirSync: typeof readdirSync
  lstatSync: typeof lstatSync
  readlinkSync: typeof readlinkSync
  symlinkSync: typeof symlinkSync
  copyFileSync: typeof copyFileSync
  chmodSync: typeof chmodSync
  renameSync: typeof renameSync
  rmSync: typeof rmSync
}

export const nodeMigrationFileSystem: MigrationFileSystem = {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  copyFileSync,
  chmodSync,
  renameSync,
  rmSync
}

export interface MigrationDependencies {
  fs?: MigrationFileSystem
  now?: () => Date
}

export interface MigrationInspection {
  needed: boolean
  legacyConfigFound: boolean
  legacyReposFound: boolean
  canonicalConfigFound: boolean
  canonicalReposFound: boolean
  journalStatus: MigrationStatus | null
  journalValid: boolean
}

interface MigrationItemState {
  status: MigrationItemStatus
  conflictCode?: MigrationConflictCode
}

export interface MigrationJournal {
  schemaVersion: 1
  action: MigrationAction | null
  status: MigrationStatus
  attempts: number
  reminderCount: number
  createdAt: string
  updatedAt: string
  config: MigrationItemState
  workingCopies: Record<string, MigrationItemState>
  errorCode?: MigrationErrorCode
}

export type MigrationConflictCode =
  | 'BACKUP_DIFFERS'
  | 'CONFIG_DESTINATION_EXISTS'
  | 'REPOSITORY_DESTINATION_EXISTS'
  | 'DESTINATION_ENTRY_DIFFERS'
  | 'UNSUPPORTED_ENTRY'
  | 'INVALID_JOURNAL'

export type MigrationErrorCode = 'MIGRATION_IO_ERROR'

export interface MigrationConflict {
  area: 'journal' | 'config' | 'working-copy'
  code: MigrationConflictCode
  item?: string
}

export interface MigrationResult {
  action: MigrationAction
  status: MigrationStatus
  configStatus: MigrationItemStatus
  workingCopies: Record<string, MigrationItemStatus>
  conflicts: MigrationConflict[]
  errorCode?: MigrationErrorCode
}

export interface AppMigrationOptions extends LocalPathOptions, MigrationDependencies {}

class SafeCopyConflict extends Error {
  constructor(readonly code: MigrationConflictCode) {
    super(code)
  }
}

export function inspectAppMigration(options: AppMigrationOptions): MigrationInspection {
  const fs = options.fs ?? nodeMigrationFileSystem
  const paths = resolveLocalPaths(options)
  const journalRead = readJournal(paths, fs)
  const legacyConfigFound = fs.existsSync(paths.legacyConfigFile)
  const legacyReposFound = fs.existsSync(paths.legacyReposDirectory)
  const resolved = journalRead.journal?.status === 'completed'
    || journalRead.journal?.status === 'skipped'

  return {
    needed: (legacyConfigFound || legacyReposFound) && !resolved,
    legacyConfigFound,
    legacyReposFound,
    canonicalConfigFound: fs.existsSync(paths.configFile),
    canonicalReposFound: fs.existsSync(paths.reposDirectory),
    journalStatus: journalRead.journal?.status ?? null,
    journalValid: journalRead.valid
  }
}

export function readAppMigrationJournal(
  options: AppMigrationOptions
): MigrationJournal | null {
  const result = readJournal(resolveLocalPaths(options), options.fs ?? nodeMigrationFileSystem)
  return result.valid ? result.journal : null
}

export function runAppMigrationAction(
  action: MigrationAction,
  options: AppMigrationOptions
): MigrationResult {
  const fs = options.fs ?? nodeMigrationFileSystem
  const paths = resolveLocalPaths(options)
  const now = options.now ?? (() => new Date())
  const journalRead = readJournal(paths, fs)

  if (!journalRead.valid) {
    return {
      action,
      status: 'blocked',
      configStatus: 'pending',
      workingCopies: {},
      conflicts: [{ area: 'journal', code: 'INVALID_JOURNAL' }]
    }
  }

  const timestamp = now().toISOString()

  if (journalRead.journal?.status === 'completed' || journalRead.journal?.status === 'skipped') {
    return resultFromJournal(journalRead.journal, [])
  }
  const journal = journalRead.journal ?? createJournal(timestamp)
  journal.action = action
  journal.updatedAt = timestamp
  delete journal.errorCode

  if (action === 'remind-later') {
    journal.status = 'pending'
    journal.reminderCount += 1
    writeJournal(paths, journal, fs)
    return resultFromJournal(journal, [])
  }

  if (action === 'start-without-migration') {
    journal.status = 'skipped'
    writeJournal(paths, journal, fs)
    return resultFromJournal(journal, [])
  }

  journal.status = 'in-progress'
  journal.attempts += 1
  writeJournal(paths, journal, fs)

  const conflicts: MigrationConflict[] = []
  try {
    migrateConfig(paths, journal, fs, conflicts)
    migrateWorkingCopies(paths, journal, fs, conflicts)
    journal.status = conflicts.length > 0 ? 'blocked' : 'completed'
  } catch {
    journal.status = 'failed'
    journal.errorCode = 'MIGRATION_IO_ERROR'
  }

  journal.updatedAt = now().toISOString()
  writeJournal(paths, journal, fs)
  return resultFromJournal(journal, conflicts)
}

function createJournal(timestamp: string): MigrationJournal {
  return {
    schemaVersion: 1,
    action: null,
    status: 'pending',
    attempts: 0,
    reminderCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    config: { status: 'pending' },
    workingCopies: {}
  }
}

function migrateConfig(
  paths: LocalPaths,
  journal: MigrationJournal,
  fs: MigrationFileSystem,
  conflicts: MigrationConflict[]
): void {
  if (!fs.existsSync(paths.legacyConfigFile)) {
    journal.config = { status: 'not-found' }
    return
  }

  const source = fs.readFileSync(paths.legacyConfigFile)
  fs.mkdirSync(paths.appDirectory, { recursive: true })

  if (!writeExclusiveOrEqual(paths.legacyConfigBackupFile, source, fs)) {
    journal.config = { status: 'conflict', conflictCode: 'BACKUP_DIFFERS' }
    conflicts.push({ area: 'config', code: 'BACKUP_DIFFERS' })
    return
  }

  if (!writeExclusiveOrEqual(paths.configFile, source, fs)) {
    journal.config = { status: 'conflict', conflictCode: 'CONFIG_DESTINATION_EXISTS' }
    conflicts.push({ area: 'config', code: 'CONFIG_DESTINATION_EXISTS' })
    return
  }

  journal.config = { status: 'completed' }
}

function migrateWorkingCopies(
  paths: LocalPaths,
  journal: MigrationJournal,
  fs: MigrationFileSystem,
  conflicts: MigrationConflict[]
): void {
  if (!fs.existsSync(paths.legacyReposDirectory)) return

  const sourceRoot = fs.lstatSync(paths.legacyReposDirectory)
  if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink()) {
    conflicts.push({ area: 'working-copy', code: 'UNSUPPORTED_ENTRY' })
    return
  }

  fs.mkdirSync(paths.reposDirectory, { recursive: true })
  const entries = fs.readdirSync(paths.legacyReposDirectory, { withFileTypes: true })

  for (const entry of entries) {
    const name = entry.name
    const source = join(paths.legacyReposDirectory, name)
    const destination = join(paths.reposDirectory, name)
    const previous = journal.workingCopies[name]

    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      journal.workingCopies[name] = { status: 'conflict', conflictCode: 'UNSUPPORTED_ENTRY' }
      conflicts.push({ area: 'working-copy', code: 'UNSUPPORTED_ENTRY', item: name })
      continue
    }

    if (fs.existsSync(destination) && previous?.status !== 'copying') {
      if (entriesEqual(source, destination, fs)) {
        journal.workingCopies[name] = { status: 'completed' }
      } else {
        journal.workingCopies[name] = {
          status: 'conflict',
          conflictCode: 'REPOSITORY_DESTINATION_EXISTS'
        }
        conflicts.push({
          area: 'working-copy',
          code: 'REPOSITORY_DESTINATION_EXISTS',
          item: name
        })
      }
      continue
    }

    journal.workingCopies[name] = { status: 'copying' }
    writeJournal(paths, journal, fs)

    try {
      copyEntryWithoutOverwrite(source, destination, fs)
      journal.workingCopies[name] = { status: 'completed' }
    } catch (error) {
      if (error instanceof SafeCopyConflict) {
        journal.workingCopies[name] = { status: 'conflict', conflictCode: error.code }
        conflicts.push({ area: 'working-copy', code: error.code, item: name })
        continue
      }
      throw error
    }
  }
}

function copyEntryWithoutOverwrite(
  source: string,
  destination: string,
  fs: MigrationFileSystem
): void {
  const sourceStat = fs.lstatSync(source)

  if (sourceStat.isSymbolicLink()) {
    const target = fs.readlinkSync(source)
    if (fs.existsSync(destination)) {
      const destinationStat = fs.lstatSync(destination)
      if (!destinationStat.isSymbolicLink() || fs.readlinkSync(destination) !== target) {
        throw new SafeCopyConflict('DESTINATION_ENTRY_DIFFERS')
      }
      return
    }
    fs.symlinkSync(target, destination)
    return
  }

  if (sourceStat.isDirectory()) {
    if (fs.existsSync(destination)) {
      if (!fs.lstatSync(destination).isDirectory()) {
        throw new SafeCopyConflict('DESTINATION_ENTRY_DIFFERS')
      }
    } else {
      fs.mkdirSync(destination, { mode: sourceStat.mode })
    }
    for (const child of fs.readdirSync(source)) {
      copyEntryWithoutOverwrite(join(source, child), join(destination, child), fs)
    }
    return
  }

  if (!sourceStat.isFile()) throw new SafeCopyConflict('UNSUPPORTED_ENTRY')

  if (fs.existsSync(destination)) {
    if (!filesEqual(source, destination, fs)) {
      throw new SafeCopyConflict('DESTINATION_ENTRY_DIFFERS')
    }
    return
  }

  try {
    fs.copyFileSync(source, destination, constants.COPYFILE_EXCL)
    fs.chmodSync(destination, sourceStat.mode)
  } catch (error) {
    if (isAlreadyExistsError(error) && filesEqual(source, destination, fs)) return
    if (isAlreadyExistsError(error)) throw new SafeCopyConflict('DESTINATION_ENTRY_DIFFERS')
    throw error
  }
}

function entriesEqual(source: string, destination: string, fs: MigrationFileSystem): boolean {
  const sourceStat = fs.lstatSync(source)
  const destinationStat = fs.lstatSync(destination)

  if (sourceStat.isSymbolicLink() || destinationStat.isSymbolicLink()) {
    return sourceStat.isSymbolicLink()
      && destinationStat.isSymbolicLink()
      && fs.readlinkSync(source) === fs.readlinkSync(destination)
  }
  if (sourceStat.isFile() || destinationStat.isFile()) {
    return sourceStat.isFile() && destinationStat.isFile() && filesEqual(source, destination, fs)
  }
  if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) return false

  const sourceNames = fs.readdirSync(source).sort()
  const destinationNames = fs.readdirSync(destination).sort()
  return sourceNames.length === destinationNames.length
    && sourceNames.every((name, index) => name === destinationNames[index])
    && sourceNames.every((name) => entriesEqual(join(source, name), join(destination, name), fs))
}

function filesEqual(source: string, destination: string, fs: MigrationFileSystem): boolean {
  const sourceStat = fs.lstatSync(source)
  const destinationStat = fs.lstatSync(destination)
  return sourceStat.isFile()
    && destinationStat.isFile()
    && sourceStat.size === destinationStat.size
    && fs.readFileSync(source).equals(fs.readFileSync(destination))
}

function writeExclusiveOrEqual(
  destination: string,
  contents: Buffer,
  fs: MigrationFileSystem
): boolean {
  if (fs.existsSync(destination)) return fs.readFileSync(destination).equals(contents)
  try {
    fs.writeFileSync(destination, contents, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error
    return fs.readFileSync(destination).equals(contents)
  }
}

function writeJournal(paths: LocalPaths, journal: MigrationJournal, fs: MigrationFileSystem): void {
  fs.mkdirSync(paths.appDirectory, { recursive: true })
  const temporaryPath = `${paths.migrationJournalFile}.tmp`
  const serialized = `${JSON.stringify(journal, null, 2)}\n`
  fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(temporaryPath, paths.migrationJournalFile)
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

function readJournal(
  paths: LocalPaths,
  fs: MigrationFileSystem
): { valid: boolean; journal: MigrationJournal | null } {
  if (!fs.existsSync(paths.migrationJournalFile)) return { valid: true, journal: null }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(paths.migrationJournalFile, 'utf8'))
    return isMigrationJournal(parsed)
      ? { valid: true, journal: parsed }
      : { valid: false, journal: null }
  } catch {
    return { valid: false, journal: null }
  }
}

function isMigrationJournal(value: unknown): value is MigrationJournal {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MigrationJournal>
  return candidate.schemaVersion === 1
    && isActionOrNull(candidate.action)
    && isStatus(candidate.status)
    && Number.isInteger(candidate.attempts)
    && typeof candidate.attempts === 'number'
    && candidate.attempts >= 0
    && Number.isInteger(candidate.reminderCount)
    && typeof candidate.reminderCount === 'number'
    && candidate.reminderCount >= 0
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && isItemState(candidate.config)
    && isWorkingCopies(candidate.workingCopies)
}

function isActionOrNull(value: unknown): value is MigrationAction | null {
  return value === null
    || value === 'migrate-now'
    || value === 'remind-later'
    || value === 'start-without-migration'
}

function isStatus(value: unknown): value is MigrationStatus {
  return value === 'pending'
    || value === 'in-progress'
    || value === 'completed'
    || value === 'blocked'
    || value === 'failed'
    || value === 'skipped'
}

function isItemState(value: unknown): value is MigrationItemState {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as MigrationItemState).status === 'string'
}

function isWorkingCopies(value: unknown): value is Record<string, MigrationItemState> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isItemState)
}

function resultFromJournal(
  journal: MigrationJournal,
  conflicts: MigrationConflict[]
): MigrationResult {
  return {
    action: journal.action ?? 'migrate-now',
    status: journal.status,
    configStatus: journal.config.status,
    workingCopies: Object.fromEntries(
      Object.entries(journal.workingCopies).map(([name, state]) => [name, state.status])
    ),
    conflicts,
    errorCode: journal.errorCode
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST'
}
