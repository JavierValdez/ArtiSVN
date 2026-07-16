import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAgentBrokerEndpoint, WINDOWS_AGENT_BROKER_ENDPOINT } from '../src/main/agent/endpoint'

test('windows broker endpoint preserves the legacy pipe for installed bridges', () => {
  assert.equal(WINDOWS_AGENT_BROKER_ENDPOINT, String.raw`\\.\pipe\javisvn-agent-broker`)
  assert.equal(WINDOWS_AGENT_BROKER_ENDPOINT.split('.')[0], String.raw`\\`)
  assert.equal(
    resolveAgentBrokerEndpoint({ platform: 'win32', userDataPath: 'ignored' }),
    String.raw`\\.\pipe\javisvn-agent-broker`
  )
})

test('mac broker endpoint preserves the legacy socket name when it fits platform limits', () => {
  assert.equal(
    resolveAgentBrokerEndpoint({
      platform: 'darwin',
      userDataPath: '/Users/example/Library/Application Support/javisvn',
      tempDir: '/tmp',
      uid: 501
    }),
    '/Users/example/Library/Application Support/javisvn/javisvn-agent-broker.sock'
  )
})

test('unix broker endpoint falls back to temp dir when userData socket path is too long', () => {
  assert.equal(
    resolveAgentBrokerEndpoint({
      platform: 'darwin',
      userDataPath: `/Users/example/${'very-long-segment/'.repeat(8)}javisvn`,
      tempDir: '/tmp',
      uid: 501
    }),
    '/tmp/javisvn-agent-broker-501.sock'
  )
})
