import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCredentialUpdate } from '../src/main/services/credential-update'
const bound = (key: string) => key === 'https://linrepo00.sat-interno.gob.gt:443' ? { username: 'fixture', password: 'fixture-only' } : null

test('an empty profile password cannot rebind the SAT password to another server or account', () => {
  assert.throws(() => resolveCredentialUpdate({ username: 'fixture', password: '', serverUrl: 'https://other.example/svn' }, 'https://other.example', bound), /contraseña/)
  assert.throws(() => resolveCredentialUpdate({ username: 'another', password: '', serverUrl: 'https://linrepo00/svn' }, '', bound), /contraseña/)
})
test('saved credentials can be reused only for the origin-bound account including SAT alias', () => {
  const result = resolveCredentialUpdate({ username: 'fixture', password: '', serverUrl: 'https://linrepo00/svn/new-path' }, '', bound)
  assert.equal(result.password, 'fixture-only')
})
test('an explicitly supplied password allows configuring a new origin', () => {
  const result = resolveCredentialUpdate({ username: 'fixture', password: 'new-fixture', serverUrl: 'https://other.example' }, '', bound)
  assert.equal(result.password, 'new-fixture')
})
