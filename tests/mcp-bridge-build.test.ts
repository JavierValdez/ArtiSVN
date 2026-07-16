import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'dist-mcp-bridge')

test('bridge build emits canonical artifacts and legacy aliases', () => {
  const result = spawnSync(process.execPath, ['scripts/build-mcp-bridge.mjs', '--sea'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(join(output, 'bridge.cjs')), true)

  if (process.platform === 'win32') {
    assert.equal(existsSync(join(output, 'ArtiSvnMcp.exe')), true)
    assert.equal(existsSync(join(output, 'JaviSvnMcp.exe')), true)
    return
  }

  for (const name of ['artisvn-mcp-bridge', 'javisvn-mcp-bridge']) {
    const artifact = join(output, name)
    assert.equal(existsSync(artifact), true)
    assert.notEqual(statSync(artifact).mode & 0o111, 0)
    assert.match(readFileSync(artifact, 'utf8'), /bridge\.cjs/)
  }
})
