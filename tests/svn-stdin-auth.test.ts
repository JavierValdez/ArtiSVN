import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { buildSvnInvocation, parseSvnOrigin, resolveTlsPolicy } from '../src/main/services/svn-policy'

/**
 * Real svn + svnserve check that `--password-from-stdin` authenticates and that
 * the password never appears in the child's argv. Uses a throwaway repository
 * and a test-only password.
 */

const TEST_PASSWORD = 'clave-de-prueba-solo-test'

function available(bin: string): boolean {
  return spawnSync(bin, ['--version', '--quiet']).status === 0
}

const SKIP = !(available('svn') && available('svnserve') && available('svnadmin')) && 'svn/svnserve no disponibles'

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('port'))))
    })
  })
}

function runSvnWithInvocation(url: string, password: string, configDir: string): Promise<{ code: number | null; args: string[]; stderr: string }> {
  const origin = parseSvnOrigin(url)
  const invocation = buildSvnInvocation({
    args: ['info', url, '--config-dir', configDir, '--no-auth-cache'],
    origin,
    policy: resolveTlsPolicy(origin),
    credentials: { username: 'tester', password }
  })
  return new Promise((resolveRun) => {
    const proc = spawn('svn', invocation.args)
    let stderr = ''
    proc.stderr.on('data', (chunk) => { stderr += String(chunk) })
    proc.stdin.end(invocation.stdin)
    proc.on('close', (code) => resolveRun({ code, args: invocation.args, stderr }))
  })
}

describe('svn --password-from-stdin against a local svnserve', { skip: SKIP }, () => {
  let root = ''
  let server: ChildProcess | null = null
  let url = ''

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'artisvn-auth-')))
    const repo = join(root, 'repo')
    assert.equal(spawnSync('svnadmin', ['create', repo]).status, 0)
    writeFileSync(join(repo, 'conf', 'svnserve.conf'), '[general]\nanon-access = none\nauth-access = read\npassword-db = passwd\n')
    writeFileSync(join(repo, 'conf', 'passwd'), `[users]\ntester = ${TEST_PASSWORD}\n`)
    const port = await freePort()
    server = spawn('svnserve', ['--foreground', '-d', '-r', root, '--listen-host', '127.0.0.1', '--listen-port', String(port)])
    url = `svn://127.0.0.1:${port}/repo`
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  })

  after(() => {
    server?.kill('SIGKILL')
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('authenticates with the password on stdin and keeps it out of argv', async () => {
    const result = await runSvnWithInvocation(url, TEST_PASSWORD, join(root, 'cfg-ok'))
    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.args.every((arg) => !arg.includes(TEST_PASSWORD)))
  })

  test('a wrong password on stdin fails authentication', async () => {
    const result = await runSvnWithInvocation(url, 'incorrecta', join(root, 'cfg-bad'))
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /E170001|E215004|Authorization|authentication/i)
  })
})
