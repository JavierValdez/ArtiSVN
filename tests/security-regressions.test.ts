import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { buildSvnInvocation, collectArgOrigins, parseSvnOrigin, resolveTlsPolicy } from '../src/main/services/svn-policy'
import { pathKey, commitSelectedPaths, revertSelectedPaths, type SvnRunner } from '../src/main/services/commit'

const origin = parseSvnOrigin('https://linrepo00.sat-interno.gob.gt/svn/sat')!

test('authentication options precede -- and commit messages are not remote targets', () => {
  const args = ['commit', '-m', 'https://tickets.example/123', '--', 'selected.txt']
  assert.deepEqual(collectArgOrigins(args), [])
  const invocation = buildSvnInvocation({ args, origin, policy: resolveTlsPolicy(origin), credentials: { username: 'dummy', password: 'fixture-only' } })
  assert.ok(invocation.args.indexOf('--password-from-stdin') < invocation.args.indexOf('--'))
  assert.ok(invocation.args.indexOf('--non-interactive') < invocation.args.indexOf('--'))
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--') + 1), ['selected.txt'])
  assert.ok(!invocation.args.includes('fixture-only'))
  assert.doesNotThrow(() => buildSvnInvocation({ args: ['commit', '-m', '--password', '--', 'a'], origin, policy: resolveTlsPolicy(origin), credentials: null }))
  assert.throws(() => buildSvnInvocation({ args: ['info', '--password', 'secret'], origin, policy: resolveTlsPolicy(origin), credentials: null }), /contraseñas/)
})

test('SVN selection preserves distinct case-sensitive macOS paths', () => {
  assert.notEqual(pathKey('A.txt', 'darwin'), pathKey('a.txt', 'darwin'))
  assert.equal(pathKey('A.txt', 'win32'), pathKey('a.txt', 'win32'))
})

const hasSvn = spawnSync('svn', ['--version', '--quiet']).status === 0 && spawnSync('svnadmin', ['--version', '--quiet']).status === 0

test('reverting an added parent cannot silently unschedule an unselected added child', { skip: !hasSvn }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'artisvn-revert-selection-'))
  try {
    execFileSync('svnadmin', ['create', join(root, 'repo')])
    const wc = join(root, 'wc')
    execFileSync('svn', ['checkout', pathToFileURL(join(root, 'repo')).href, wc, '--non-interactive'])
    mkdirSync(join(wc, 'added')); writeFileSync(join(wc, 'added', 'child.txt'), 'keep scheduled\n')
    execFileSync('svn', ['add', 'added'], { cwd: wc })
    const run: SvnRunner = async (args, options) => ({ stdout: execFileSync('svn', args, { cwd: options.cwd, encoding: 'utf8' }), stderr: '' })
    await assert.rejects(revertSelectedPaths(wc, ['added'], run), /no seleccionados/)
    assert.match(execFileSync('svn', ['status', 'added/child.txt'], { cwd: wc, encoding: 'utf8' }), /^A/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('checkout cannot forward an origin-bound password to an HTTP svn:external', { skip: !hasSvn, timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'artisvn-externals-scope-'))
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    response.writeHead(request.headers.authorization ? 403 : 401, { 'WWW-Authenticate': 'Basic realm="fixture-only"' }); response.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object')
    const config = join(root, 'config')
    const svn = (args: string[], cwd?: string) => execFileSync('svn', [...args, '--non-interactive', '--no-auth-cache', '--config-dir', config], { cwd, encoding: 'utf8', timeout: 15_000 })
    execFileSync('svnadmin', ['create', join(root, 'repo')])
    const url = pathToFileURL(join(root, 'repo')).href
    const wc = join(root, 'wc')
    svn(['checkout', url, wc])
    svn(['propset', 'svn:externals', `external http://127.0.0.1:${address.port}/external`, '.'], wc)
    svn(['commit', '-m', 'fixture external'], wc)
    const invocation = buildSvnInvocation({
      args: ['checkout', '--config-dir', config, '--no-auth-cache', '--', url, join(root, 'download')],
      origin, policy: resolveTlsPolicy(origin), credentials: { username: 'fixture', password: 'fixture-only' }
    })
    assert.ok(invocation.args.includes('--ignore-externals'))
    await new Promise<void>((resolve, reject) => {
      const child = spawn('svn', invocation.args)
      let stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr += String(chunk) })
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture checkout timeout')) }, 20_000)
      child.on('error', reject)
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr)) })
      child.stdin.on('error', () => {}); child.stdin.end(invocation.stdin)
    })
    assert.equal(requests, 0, 'El CLI no debe contactar referencias externas con la credencial del destino principal')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})


test('partially failing preparation unadds only its own paths and preserves file contents', { skip: !hasSvn }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'artisvn-partial-add-'))
  try {
    execFileSync('svnadmin', ['create', join(root, 'repo')])
    const wc = join(root, 'wc')
    execFileSync('svn', ['checkout', pathToFileURL(join(root, 'repo')).href, wc, '--non-interactive'])
    mkdirSync(join(wc, 'new'))
    writeFileSync(join(wc, 'new', 'a.txt'), 'a must survive')
    writeFileSync(join(wc, 'new', 'b.txt'), 'b must survive')
    const run: SvnRunner = async (args, options) => {
      if (args[0] === 'add') {
        const file = args[args.indexOf('--targets') + 1]
        const first = readFileSync(file, 'utf8').trim().split('\n')[0]
        execFileSync('svn', ['add', '--parents', '--depth', 'empty', '--', first], { cwd: options.cwd })
        throw new Error('simulated partial add failure')
      }
      return { stdout: execFileSync('svn', args, { cwd: options.cwd, encoding: 'utf8' }), stderr: '' }
    }
    await assert.rejects(commitSelectedPaths(wc, ['new/a.txt', 'new/b.txt'], 'must fail safely', run), /partial add failure/)
    assert.doesNotMatch(execFileSync('svn', ['status'], { cwd: wc, encoding: 'utf8' }), /^A/m)
    assert.equal(readFileSync(join(wc, 'new', 'a.txt'), 'utf8'), 'a must survive')
    assert.equal(readFileSync(join(wc, 'new', 'b.txt'), 'utf8'), 'b must survive')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
