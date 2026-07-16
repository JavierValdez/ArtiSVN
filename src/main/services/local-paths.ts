import { homedir } from 'node:os'
import { join } from 'node:path'

export const CANONICAL_APP_DIRECTORY_NAME = 'artisvn'
export const CANONICAL_CONFIG_FILE_NAME = 'artisvn-config.json'
export const CANONICAL_REPOS_DIRECTORY_NAME = 'ArtiSVN'
export const LEGACY_APP_DIRECTORY_NAME = 'javisvn'
export const LEGACY_CONFIG_FILE_NAME = 'javisvn-config.json'
export const LEGACY_REPOS_DIRECTORY_NAME = 'JaviSvn'
export const MIGRATION_JOURNAL_FILE_NAME = 'migration-state.json'
export const LEGACY_CONFIG_BACKUP_FILE_NAME = 'javisvn-config.json.raw-backup'

export interface LocalPathOptions {
  appDataPath: string
  homePath?: string
  documentsPath?: string
}

export interface LocalPaths {
  appDirectory: string
  configFile: string
  reposDirectory: string
  legacyAppDirectory: string
  legacyConfigFile: string
  legacyReposDirectory: string
  migrationJournalFile: string
  legacyConfigBackupFile: string
}

/**
 * Resolves all application paths without importing Electron. Callers can pass
 * Electron's appData/documents paths, while tests can use isolated directories.
 */
export function resolveLocalPaths(options: LocalPathOptions): LocalPaths {
  const documentsPath = options.documentsPath ?? join(options.homePath ?? homedir(), 'Documents')
  const appDirectory = join(options.appDataPath, CANONICAL_APP_DIRECTORY_NAME)
  const legacyAppDirectory = join(options.appDataPath, LEGACY_APP_DIRECTORY_NAME)

  return {
    appDirectory,
    configFile: join(appDirectory, CANONICAL_CONFIG_FILE_NAME),
    reposDirectory: join(documentsPath, CANONICAL_REPOS_DIRECTORY_NAME),
    legacyAppDirectory,
    legacyConfigFile: join(legacyAppDirectory, LEGACY_CONFIG_FILE_NAME),
    legacyReposDirectory: join(documentsPath, LEGACY_REPOS_DIRECTORY_NAME),
    migrationJournalFile: join(appDirectory, MIGRATION_JOURNAL_FILE_NAME),
    legacyConfigBackupFile: join(appDirectory, LEGACY_CONFIG_BACKUP_FILE_NAME)
  }
}

export const BASE_REPO_PATH = join(homedir(), 'Documents', CANONICAL_REPOS_DIRECTORY_NAME)
