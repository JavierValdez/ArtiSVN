import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MCP_DISPLAY_NAME, MCP_ENV, MCP_SERVER_NAME, resolveMcpEnv } from '../src/main/agent/identity'

test('MCP identity is canonical ArtiSVN/artisvn', () => {
  assert.equal(MCP_DISPLAY_NAME, 'ArtiSVN')
  assert.equal(MCP_SERVER_NAME, 'artisvn')
  assert.equal(MCP_ENV.token, 'ARTISVN_MCP_TOKEN')
  assert.equal(MCP_ENV.legacyToken, 'JAVISVN_MCP_TOKEN')
})

test('canonical ARTISVN environment values take precedence over JAVISVN aliases', () => {
  assert.equal(resolveMcpEnv({
    ARTISVN_MCP_TOKEN: 'canonical',
    JAVISVN_MCP_TOKEN: 'legacy'
  }, MCP_ENV.token, MCP_ENV.legacyToken), 'canonical')

  assert.equal(resolveMcpEnv({
    JAVISVN_MCP_TOKEN: 'legacy'
  }, MCP_ENV.token, MCP_ENV.legacyToken), 'legacy')

  assert.equal(resolveMcpEnv({
    ARTISVN_MCP_TOKEN: '',
    JAVISVN_MCP_TOKEN: 'legacy'
  }, MCP_ENV.token, MCP_ENV.legacyToken), '')
})
