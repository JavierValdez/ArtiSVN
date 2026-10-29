import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { cleanIpcError, saveCredentials, toPublicCredentials, type CredentialsApi } from '../src/renderer/src/utils/credentialsSave'
import { describeSkippedExternals } from '../src/renderer/src/utils/externals'
import { getSearchExpansionTrail } from '../src/renderer/src/components/explorer/explorerUtils'
import { isInvalidLocalName } from '../src/renderer/src/components/explorer/useCheckoutExport'
import { buildExternalsNotice, countExternalDefinitions } from '../src/main/services/externals-contract'

const ORIGIN_ERROR = "Error invoking remote method 'creds:update': Error: Ingresa la contraseña para este usuario y servidor; no se reutiliza la clave de otro origen."

function fakeApi(overrides: Partial<CredentialsApi> = {}) {
  const calls: string[] = []
  const api: CredentialsApi = {
    async setCredentials() { calls.push('set'); return true },
    async updateCredentials() { calls.push('update'); return true },
    async getCredentials() {
      calls.push('get')
      // Main returns the sanitized shape; a stray password field must be dropped.
      return { username: 'ana', serverUrl: 'https://linrepo00.sat-interno.gob.gt/svn', hasPassword: true, password: 'no-debe-quedar' } as any
    },
    ...overrides
  }
  return { api, calls }
}

test('profile save without password that main rejects returns a visible error and never throws', async () => {
  const { api, calls } = fakeApi({ async updateCredentials() { throw new Error(ORIGIN_ERROR) } })
  const result = await saveCredentials(api, { username: 'ana', password: '', serverUrl: 'https://otro.example/svn' }, 'update')
  assert.equal(result.ok, false)
  assert.equal((result as any).error, 'Ingresa la contraseña para este usuario y servidor; no se reutiliza la clave de otro origen.')
  assert.deepEqual(calls, [], 'no state reload after a failed save')
})

test('successful saves reload sanitized credentials from main (hasPassword, no password)', async () => {
  const { api, calls } = fakeApi()
  const replaced = await saveCredentials(api, { username: 'ana', password: 'x', serverUrl: 'https://h/svn' }, 'replace')
  assert.equal(replaced.ok, true)
  assert.deepEqual((replaced as any).credentials, { username: 'ana', serverUrl: 'https://linrepo00.sat-interno.gob.gt/svn', hasPassword: true })
  assert.ok(!('password' in (replaced as any).credentials))

  const updated = await saveCredentials(api, { username: 'ana', password: '', serverUrl: 'https://h/svn' }, 'update')
  assert.equal(updated.ok, true)
  assert.deepEqual(calls, ['set', 'get', 'update', 'get'])

  const withTypedPassword = await saveCredentials(api, { username: 'ana', password: 'nueva', serverUrl: 'https://h/svn' }, 'update')
  assert.equal(withTypedPassword.ok, true)
  assert.equal(calls.at(-2), 'set', 'a typed password replaces credentials')
})

test('auth save errors from setCredentials are reported', async () => {
  const { api } = fakeApi({ async setCredentials() { throw new Error("Error invoking remote method 'creds:set': Error: Las credenciales solo se guardan para servidores https://, svn:// o svn+ssh://") } })
  const result = await saveCredentials(api, { username: 'ana', password: 'x', serverUrl: 'http://h/svn' }, 'replace')
  assert.equal(result.ok, false)
  assert.match((result as any).error, /^Las credenciales solo se guardan/)
})

test('public credential helpers', () => {
  assert.equal(toPublicCredentials(null), null)
  assert.equal(toPublicCredentials({ username: '', serverUrl: '' }), null)
  assert.equal(cleanIpcError(new Error(''), 'fallback'), 'fallback')
})

test('externals notices', async () => {
  assert.equal(buildExternalsNotice(0), null)
  assert.match(buildExternalsNotice(2) || '', /2 definiciones svn:externals.*por separado/)
  assert.equal(describeSkippedExternals(undefined), null)
  assert.match(describeSkippedExternals(1) || '', /Se omitió 1 svn:external\./)
  assert.match(describeSkippedExternals(3) || '', /Se omitieron 3 svn:externals/)
  assert.match(buildExternalsNotice(1) || '', /1 definición svn:externals que no se descargó\./)
  const xml = `<?xml version="1.0"?><properties>
    <target path="/wc/a"><property name="svn:externals">ext1 https://h/b
# comentario
ext2 https://h/c
</property></target>
    <target path="/wc/a/sub"><property name="svn:externals">x https://otro/d</property></target>
  </properties>`
  assert.equal(await countExternalDefinitions(xml), 3)
  assert.equal(await countExternalDefinitions(''), 0)
})

const hasSvn = spawnSync('svn', ['--version', '--quiet']).status === 0 && spawnSync('svnadmin', ['--version', '--quiet']).status === 0

test('checkout with --ignore-externals leaves definitions that propget reports offline', { skip: !hasSvn }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'artisvn-externals-notice-')))
  try {
    const run = (args: string[]) => {
      const r = spawnSync('svn', [...args, '--non-interactive'], { encoding: 'utf-8' })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout
    }
    spawnSync('svnadmin', ['create', join(root, 'repo')])
    const url = pathToFileURL(join(root, 'repo')).href
    run(['mkdir', '-m', 'd', `${url}/a`, `${url}/b`])
    run(['checkout', url, join(root, 'seed')])
    run(['propset', 'svn:externals', `ext ${url}/b`, join(root, 'seed', 'a')])
    run(['commit', '-m', 'ext', join(root, 'seed')])
    run(['checkout', '--ignore-externals', url, join(root, 'wc')])
    const xml = run(['propget', 'svn:externals', '-R', '--xml', join(root, 'wc')])
    assert.equal(await countExternalDefinitions(xml), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('explorer search expansion trail and local name validation', () => {
  assert.deepEqual(getSearchExpansionTrail('https://h/r/', 'https://h/r/a/b/c.txt'), ['https://h/r', 'https://h/r/a', 'https://h/r/a/b'])
  assert.deepEqual(getSearchExpansionTrail('https://h/r', 'https://h/r/x'), ['https://h/r'])
  assert.equal(getSearchExpansionTrail('https://h/r', 'https://h/other/x'), null)
  assert.equal(isInvalidLocalName('..'), true)
  assert.equal(isInvalidLocalName('a/b'), true)
  assert.equal(isInvalidLocalName('repo-ok'), false)
})
