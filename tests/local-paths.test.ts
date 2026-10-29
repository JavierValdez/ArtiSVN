import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BASE_REPO_PATH,
  CANONICAL_REPOS_DIRECTORY_NAME,
  resolveLocalPaths
} from '../src/main/services/local-paths'

test('local paths resolve canonical ArtiSVN locations and legacy JaviSVN locations', () => {
  const paths = resolveLocalPaths({
    appDataPath: '/isolated/app-data',
    documentsPath: '/isolated/documents'
  })

  assert.deepEqual(paths, {
    appDirectory: join('/isolated/app-data', 'artisvn'),
    configFile: join('/isolated/app-data', 'artisvn', 'artisvn-config.json'),
    reposDirectory: join('/isolated/documents', 'ArtiSVN'),
    legacyAppDirectory: join('/isolated/app-data', 'javisvn'),
    legacyConfigFile: join('/isolated/app-data', 'javisvn', 'javisvn-config.json'),
    legacyReposDirectory: join('/isolated/documents', 'JaviSvn'),
    migrationJournalFile: join('/isolated/app-data', 'artisvn', 'migration-state.json'),
    legacyConfigBackupFile: join('/isolated/app-data', 'artisvn', 'javisvn-config.json.raw-backup')
  })
})

test('local paths derive Documents from an injected home path', () => {
  const paths = resolveLocalPaths({
    appDataPath: '/app-data',
    homePath: '/users/tester'
  })

  assert.equal(paths.reposDirectory, join('/users/tester', 'Documents', 'ArtiSVN'))
  assert.equal(paths.legacyReposDirectory, join('/users/tester', 'Documents', 'JaviSvn'))
})

test('the shared repository base now uses the canonical directory name', () => {
  assert.equal(BASE_REPO_PATH.endsWith(join('Documents', CANONICAL_REPOS_DIRECTORY_NAME)), true)
})

test('dev-only documents override is ignored outside development', async () => {
  const { resolveDocumentsDirectory } = await import('../src/main/services/local-paths')
  assert.equal(resolveDocumentsDirectory({ NODE_ENV: 'development', ARTISVN_DEV_DOCUMENTS_DIR: '/tmp/docs' }, '/home/x'), '/tmp/docs')
  assert.equal(resolveDocumentsDirectory({ ARTISVN_DEV_DOCUMENTS_DIR: '/tmp/docs' }, '/home/x'), join('/home/x', 'Documents'))
  assert.equal(resolveDocumentsDirectory({ NODE_ENV: 'production', ARTISVN_DEV_DOCUMENTS_DIR: '/tmp/docs' }, '/home/x'), join('/home/x', 'Documents'))
  assert.equal(resolveDocumentsDirectory({ NODE_ENV: 'development' }, '/home/x'), join('/home/x', 'Documents'))
})
