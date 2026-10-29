import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import {
  buildHistoricalRemoteTarget,
  buildRepoId,
  normalizeRemoteRevision,
  resolveRepoRelativeTarget,
  truncateText,
  validateReadOnlyRemoteUrl
} from '../src/main/services/read-contract'

test('read contract validates free URLs and rejects embedded credentials', () => {
  assert.equal(validateReadOnlyRemoteUrl('https://svn.example.com/repo'), 'https://svn.example.com/repo')
  assert.equal(validateReadOnlyRemoteUrl('svn+ssh://svn.example.com/repo'), 'svn+ssh://svn.example.com/repo')
  assert.throws(() => validateReadOnlyRemoteUrl('https://user:pass@svn.example.com/repo'), /credenciales/)
  assert.throws(() => validateReadOnlyRemoteUrl('file:///tmp/repo'), /Esquema/)
})

test('read contract truncates large text and produces stable repo ids', () => {
  assert.deepEqual(truncateText('abc', 10), {
    text: 'abc',
    truncated: false,
    originalLength: 3
  })

  const truncated = truncateText('abcdef', 3)
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.originalLength, 6)
  assert.match(truncated.text, /^abc/)

  assert.equal(buildRepoId('/tmp/repo'), buildRepoId('/tmp/repo'))
})

test('read contract rejects file targets outside the repository', () => {
  assert.equal(resolveRepoRelativeTarget('/tmp/repo', 'src/app.ts').relativePath, join('src', 'app.ts'))
  assert.throws(() => resolveRepoRelativeTarget('/tmp/repo', '../outside.ts'), /fuera del repositorio/)
})

test('read contract builds historical remote targets with positive revisions only', () => {
  assert.equal(normalizeRemoteRevision(undefined), undefined)
  assert.equal(normalizeRemoteRevision(123), 123)
  assert.deepEqual(buildHistoricalRemoteTarget('https://svn.example.com/repo', 123), {
    safeUrl: 'https://svn.example.com/repo',
    targetUrl: 'https://svn.example.com/repo@123',
    revision: 123,
    revisionArgs: ['-r', '123']
  })
  assert.throws(() => normalizeRemoteRevision(0), /entero positivo/)
  assert.throws(() => normalizeRemoteRevision(12.5), /entero positivo/)
})
