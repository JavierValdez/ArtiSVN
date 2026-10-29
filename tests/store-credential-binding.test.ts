import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = buildSync({ entryPoints: [resolve(import.meta.dirname, '../src/main/services/store.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] }).outputFiles[0].text

test('legacy credentials are bound before navigation changes the displayed server URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'artisvn-store-origin-'))
  try {
    const module = { exports: {} as Record<string, (...args: any[]) => any> }
    runInNewContext(compiled, {
      module, exports: module.exports, Buffer, process, URL,
      require: (name: string) => name === 'electron' ? {
        app: { getPath: () => root },
        safeStorage: { isEncryptionAvailable: () => false }
      } : require(name)
    })
    const store = module.exports
    store.storeSet('credentials', { username: 'fixture', passwordEncrypted: 'ciphertext-fixture-not-a-secret', serverUrl: 'https://linrepo00.sat-interno.gob.gt/svn/sat' })
    store.setCurrentServerUrl('https://unrelated.example/svn')
    assert.deepEqual(Array.from(store.listCredentialOriginKeys()), ['https://linrepo00.sat-interno.gob.gt:443'])
    assert.equal(store.getCredentialsForOrigin('https://unrelated.example:443'), null)
    store.clearStoredCredentials()
    assert.deepEqual(Array.from(store.listCredentialOriginKeys()), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
