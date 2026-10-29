import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertNoPasswordArgs,
  buildSvnInvocation,
  collectArgOrigins,
  credentialOriginKey,
  credentialOriginKeyFromUrl,
  parseSvnOrigin,
  resolveTlsPolicy,
  SAT_LEGACY_SVN_ALIAS,
  SAT_LEGACY_SVN_HOST
} from '../src/main/services/svn-policy'

const SECRET = 'S3cr3t-no-debe-aparecer'
const creds = { username: 'usuario', password: SECRET }

function policyFor(url: string) {
  return resolveTlsPolicy(parseSvnOrigin(url))
}

test('SAT legacy TLS policy applies only to the exact host and its documented alias', () => {
  const fqdn = policyFor(`https://${SAT_LEGACY_SVN_HOST}/svn/repo`)
  assert.equal(fqdn.mode, 'legacy-sat')
  assert.equal(fqdn.legacyOpenSsl, true)
  assert.ok(fqdn.trustFailures.includes('unknown-ca'))
  assert.ok(fqdn.trustFailures.includes('expired'))
  assert.ok(!fqdn.trustFailures.includes('cn-mismatch'), 'el FQDN coincide con el CN del certificado')

  const alias = policyFor(`https://${SAT_LEGACY_SVN_ALIAS}/svn/repo`)
  assert.equal(alias.mode, 'legacy-sat')
  assert.ok(alias.trustFailures.includes('cn-mismatch'), 'el alias corto no coincide con el CN')

  // Uppercase / trailing dot / explicit default port still match exactly.
  assert.equal(policyFor('https://LINREPO00.SAT-INTERNO.GOB.GT:443/x').mode, 'legacy-sat')
  assert.equal(policyFor('https://linrepo00.sat-interno.gob.gt./x').mode, 'legacy-sat')
})

test('no wildcard: other SAT hosts and look-alikes stay strict', () => {
  for (const url of [
    'https://otro.sat-interno.gob.gt/svn',
    'https://linrepo00.sat-interno.gob.gt.evil.example/svn',
    'https://evil-linrepo00.sat-interno.gob.gt/svn',
    'https://linrepo001/svn',
    'https://github.com/x',
    'http://linrepo00.sat-interno.gob.gt/svn',
    'svn://linrepo00.sat-interno.gob.gt/repo'
  ]) {
    const policy = policyFor(url)
    assert.equal(policy.mode, 'strict', url)
    assert.equal(policy.legacyOpenSsl, false, url)
    assert.deepEqual(policy.trustFailures, [], url)
  }
})

test('explicit per-origin overrides can force strict or opt-in an exact origin', () => {
  const sat = parseSvnOrigin(`https://${SAT_LEGACY_SVN_HOST}/svn`)
  assert.equal(resolveTlsPolicy(sat, { [sat!.key]: 'strict' }).mode, 'strict')
  const other = parseSvnOrigin('https://svn.example.org/repo')
  const optIn = resolveTlsPolicy(other, { [other!.key]: 'legacy-sat' })
  assert.equal(optIn.mode, 'legacy-sat')
  assert.ok(!optIn.trustFailures.includes('cn-mismatch'))
  // A different port is a different origin.
  const otherPort = parseSvnOrigin('https://svn.example.org:8443/repo')
  assert.equal(resolveTlsPolicy(otherPort, { [other!.key]: 'legacy-sat' }).mode, 'strict')
})

test('the password is sent through stdin, never argv', () => {
  const origin = parseSvnOrigin(`https://${SAT_LEGACY_SVN_HOST}/svn/repo`)
  const invocation = buildSvnInvocation({
    args: ['info', '--xml', `https://${SAT_LEGACY_SVN_HOST}/svn/repo`],
    origin,
    policy: resolveTlsPolicy(origin),
    credentials: creds
  })
  assert.equal(invocation.sendsCredentials, true)
  assert.ok(invocation.args.includes('--password-from-stdin'))
  assert.ok(!invocation.args.includes('--password'))
  assert.ok(invocation.args.every((arg) => !arg.includes(SECRET)), 'la contraseña no está en argv')
  assert.equal(invocation.stdin, `${SECRET}${process.platform === 'win32' ? '\r\n' : '\n'}`)
  assert.ok(invocation.args.includes('--non-interactive'))
  assert.ok(invocation.args.some((arg) => arg.startsWith('--trust-server-cert-failures=')))
})

test('passwords containing CR or LF cannot inject another stdin line', () => {
  const origin = parseSvnOrigin('svn://127.0.0.1/repo')
  for (const separator of ['\r', '\n', '\r\n']) {
    assert.throws(() => buildSvnInvocation({
      args: ['info', 'svn://127.0.0.1/repo'],
      origin,
      policy: resolveTlsPolicy(origin),
      credentials: { username: 'tester', password: `first${separator}second` }
    }), /saltos de línea/)
  }
})

test('credentials are never sent over http and strict origins get no trust flags', () => {
  const httpOrigin = parseSvnOrigin('http://linrepo00.sat-interno.gob.gt/svn')
  const invocation = buildSvnInvocation({
    args: ['info', 'http://linrepo00.sat-interno.gob.gt/svn'],
    origin: httpOrigin,
    policy: resolveTlsPolicy(httpOrigin),
    credentials: creds
  })
  assert.equal(invocation.sendsCredentials, false)
  assert.equal(invocation.stdin, '')
  assert.ok(!invocation.args.includes('--username'))
  assert.ok(invocation.args.every((arg) => !arg.startsWith('--trust-server-cert')))
})

test('no origin (unknown target) means no credentials', () => {
  const invocation = buildSvnInvocation({
    args: ['status', '--xml'],
    origin: null,
    policy: resolveTlsPolicy(null),
    credentials: creds
  })
  assert.equal(invocation.sendsCredentials, false)
  assert.equal(invocation.stdin, '')
})

test('explicit --password arguments are rejected', () => {
  assert.throws(() => assertNoPasswordArgs(['info', '--password', 'x']), /contraseñas/)
  assert.throws(() => assertNoPasswordArgs(['info', '--password=x']), /contraseñas/)
  assert.doesNotThrow(() => assertNoPasswordArgs(['info', '--password-from-stdin']))
})

test('credential origin binding: alias and FQDN share credentials, other hosts/schemes/ports do not', () => {
  const fqdnKey = credentialOriginKeyFromUrl(`https://${SAT_LEGACY_SVN_HOST}/svn/a`)
  assert.equal(fqdnKey, `https://${SAT_LEGACY_SVN_HOST}:443`)
  assert.equal(credentialOriginKeyFromUrl(`https://${SAT_LEGACY_SVN_ALIAS}/svn/b`), fqdnKey)
  assert.notEqual(credentialOriginKeyFromUrl(`http://${SAT_LEGACY_SVN_HOST}/svn/a`), fqdnKey)
  assert.notEqual(credentialOriginKeyFromUrl(`https://${SAT_LEGACY_SVN_HOST}:8443/svn/a`), fqdnKey)
  assert.notEqual(credentialOriginKeyFromUrl('https://attacker.example/svn'), fqdnKey)
  assert.equal(credentialOriginKeyFromUrl('file:///tmp/repo'), null)
  assert.equal(credentialOriginKeyFromUrl('/local/path'), null)
})

test('origins are collected from URL arguments, including peg revisions', () => {
  const origins = collectArgOrigins(['diff', '-c5', `https://${SAT_LEGACY_SVN_HOST}/svn/a.txt@HEAD`, '-m', 'x'])
  assert.equal(origins.length, 1)
  assert.equal(credentialOriginKey(origins[0]), `https://${SAT_LEGACY_SVN_HOST}:443`)
})
