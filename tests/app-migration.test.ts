import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  inspectAppMigration,
  nodeMigrationFileSystem,
  readAppMigrationJournal,
  runAppMigrationAction,
  type AppMigrationOptions,
  type MigrationFileSystem
} from '../src/main/services/app-migration'
import { resolveLocalPaths } from '../src/main/services/local-paths'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { options: AppMigrationOptions; paths: ReturnType<typeof resolveLocalPaths> } {
  const root = mkdtempSync(join(tmpdir(), 'artisvn-migration-'))
  temporaryRoots.push(root)
  const options = {
    appDataPath: join(root, 'app-data'),
    documentsPath: join(root, 'documents'),
    now: () => new Date('2026-07-16T06:00:00.000Z')
  }
  return { options, paths: resolveLocalPaths(options) }
}

function write(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

test('migration detection reports legacy sources without reading config values', () => {
  const { options, paths } = fixture()
  write(paths.legacyConfigFile, '{"opaqueSecret":"must-not-leak"}')
  mkdirSync(paths.legacyReposDirectory, { recursive: true })

  assert.deepEqual(inspectAppMigration(options), {
    needed: true,
    legacyConfigFound: true,
    legacyReposFound: true,
    canonicalConfigFound: false,
    canonicalReposFound: false,
    journalStatus: null,
    journalValid: true
  })
})

test('migrate-now preserves raw config, backs it up exclusively, and copies working copies', () => {
  const { options, paths } = fixture()
  const rawConfig = Buffer.from(JSON.stringify({
    credentials: { username: 'user', passwordEncrypted: 'opaque-encrypted-value', serverUrl: 'https://svn.example' },
    remoteServers: [{ id: 'remote-1', name: 'Servidor', url: 'https://svn.example', createdAt: '2026-01-01T00:00:00.000Z' }],
    preferences: { theme: 'system' },
    agentIntegration: { enabled: true, tokenEncrypted: 'opaque-mcp-token' },
    svnBinPath: '/opt/svn/bin/svn',
    futureKey: 42
  }, null, 2) + '\n')
  write(paths.legacyConfigFile, rawConfig)
  write(join(paths.legacyReposDirectory, 'repo-one', '.svn', 'wc.db'), 'metadata')
  write(join(paths.legacyReposDirectory, 'repo-one', 'src', 'file.txt'), 'source')

  const result = runAppMigrationAction('migrate-now', options)

  assert.equal(result.status, 'completed')
  assert.equal(result.configStatus, 'completed')
  assert.deepEqual(result.workingCopies, { 'repo-one': 'completed' })
  assert.deepEqual(readFileSync(paths.configFile), rawConfig)
  assert.deepEqual(readFileSync(paths.legacyConfigBackupFile), rawConfig)
  if (process.platform !== 'win32') {
    assert.equal(statSync(paths.configFile).mode & 0o777, 0o600)
    assert.equal(statSync(paths.legacyConfigBackupFile).mode & 0o777, 0o600)
  }
  assert.equal(readFileSync(join(paths.reposDirectory, 'repo-one', 'src', 'file.txt'), 'utf8'), 'source')
  assert.equal(existsSync(paths.legacyConfigFile), true)
  assert.equal(existsSync(join(paths.legacyReposDirectory, 'repo-one', '.svn', 'wc.db')), true)
  assert.equal(inspectAppMigration(options).needed, false)

  const journalText = readFileSync(paths.migrationJournalFile, 'utf8')
  assert.equal(journalText.includes('opaque-encrypted-value'), false)
  assert.equal(journalText.includes('opaque-mcp-token'), false)
  assert.equal(readAppMigrationJournal(options)?.attempts, 1)
})

test('migration is idempotent and does not overwrite its raw backup', () => {
  const { options, paths } = fixture()
  write(paths.legacyConfigFile, '{"value":1}')
  write(join(paths.legacyReposDirectory, 'repo', 'tracked.txt'), 'same')

  assert.equal(runAppMigrationAction('migrate-now', options).status, 'completed')
  const firstBackup = readFileSync(paths.legacyConfigBackupFile)
  assert.equal(runAppMigrationAction('migrate-now', options).status, 'completed')
  assert.equal(runAppMigrationAction('remind-later', options).status, 'completed')
  assert.equal(runAppMigrationAction('start-without-migration', options).status, 'completed')

  assert.deepEqual(readFileSync(paths.legacyConfigBackupFile), firstBackup)
  const journal = readAppMigrationJournal(options)
  assert.equal(journal?.attempts, 1)
  assert.equal(journal?.status, 'completed')
  assert.equal(journal?.action, 'migrate-now')
  assert.equal(journal?.reminderCount, 0)
})

test('remind-later and start-without-migration persist decisions without copying data', () => {
  const { options, paths } = fixture()
  write(paths.legacyConfigFile, '{"value":1}')

  const reminder = runAppMigrationAction('remind-later', options)
  assert.equal(reminder.status, 'pending')
  assert.equal(existsSync(paths.configFile), false)
  assert.equal(readAppMigrationJournal(options)?.reminderCount, 1)

  const skipped = runAppMigrationAction('start-without-migration', options)
  assert.equal(skipped.status, 'skipped')
  assert.equal(existsSync(paths.configFile), false)
  assert.equal(existsSync(paths.legacyConfigFile), true)
})

test('migration blocks safely when config backup or destination differs', () => {
  const { options, paths } = fixture()
  write(paths.legacyConfigFile, '{"legacy":true}')
  write(paths.legacyConfigBackupFile, '{"different":true}')
  write(paths.configFile, '{"canonical":true}')

  const result = runAppMigrationAction('migrate-now', options)

  assert.equal(result.status, 'blocked')
  assert.equal(result.configStatus, 'conflict')
  assert.deepEqual(result.conflicts, [{ area: 'config', code: 'BACKUP_DIFFERS' }])
  assert.equal(readFileSync(paths.legacyConfigBackupFile, 'utf8'), '{"different":true}')
  assert.equal(readFileSync(paths.configFile, 'utf8'), '{"canonical":true}')
})

test('migration never merges an unrelated existing working-copy destination', () => {
  const { options, paths } = fixture()
  write(join(paths.legacyReposDirectory, 'repo', 'source.txt'), 'source')
  write(join(paths.reposDirectory, 'repo', 'destination.txt'), 'destination')

  const result = runAppMigrationAction('migrate-now', options)

  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.workingCopies, { repo: 'conflict' })
  assert.equal(existsSync(join(paths.reposDirectory, 'repo', 'source.txt')), false)
  assert.equal(readFileSync(join(paths.reposDirectory, 'repo', 'destination.txt'), 'utf8'), 'destination')
})

test('a failed partial working-copy migration can resume without overwriting copied files', () => {
  const { options, paths } = fixture()
  write(join(paths.legacyReposDirectory, 'repo', 'a.txt'), 'a')
  write(join(paths.legacyReposDirectory, 'repo', 'b.txt'), 'b')
  let copyCalls = 0
  const failingFs: MigrationFileSystem = {
    ...nodeMigrationFileSystem,
    copyFileSync(source, destination, mode) {
      copyCalls += 1
      if (copyCalls === 2) throw Object.assign(new Error('injected failure'), { code: 'EIO' })
      return nodeMigrationFileSystem.copyFileSync(source, destination, mode)
    }
  }

  const failed = runAppMigrationAction('migrate-now', { ...options, fs: failingFs })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.errorCode, 'MIGRATION_IO_ERROR')
  assert.equal(readAppMigrationJournal(options)?.workingCopies.repo.status, 'copying')

  const retried = runAppMigrationAction('migrate-now', options)
  assert.equal(retried.status, 'completed')
  assert.equal(readFileSync(join(paths.reposDirectory, 'repo', 'a.txt'), 'utf8'), 'a')
  assert.equal(readFileSync(join(paths.reposDirectory, 'repo', 'b.txt'), 'utf8'), 'b')
  assert.equal(existsSync(join(paths.legacyReposDirectory, 'repo', 'a.txt')), true)
})

test('an invalid journal blocks migration rather than being overwritten', () => {
  const { options, paths } = fixture()
  write(paths.legacyConfigFile, '{"legacy":true}')
  write(paths.migrationJournalFile, 'not-json')

  const result = runAppMigrationAction('migrate-now', options)

  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.conflicts, [{ area: 'journal', code: 'INVALID_JOURNAL' }])
  assert.equal(readFileSync(paths.migrationJournalFile, 'utf8'), 'not-json')
  assert.equal(existsSync(paths.configFile), false)
})
