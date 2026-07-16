import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAgentClientEnvironment, buildAgentClientLaunchConfig } from '../src/main/agent/client-config'

test('new client config emits canonical ArtiSVN environment keys only', () => {
  const env = buildAgentClientEnvironment('test-token')
  assert.deepEqual(env, {
    ARTISVN_MCP_TOKEN: 'test-token',
    ARTISVN_MCP_STDIO: '1',
    ELECTRON_RUN_AS_NODE: ''
  })
  assert.equal('JAVISVN_MCP_TOKEN' in env, false)
})

test('client config launches the canonical standalone bridge names', () => {
  assert.deepEqual(buildAgentClientLaunchConfig({
    platform: 'darwin',
    execPath: '/Applications/ArtiSVN.app/Contents/MacOS/ArtiSVN',
    launchArgs: ['--mcp-stdio'],
    mcpBridgeExePath: '/Applications/ArtiSVN.app/Contents/Resources/bridge/artisvn-mcp-bridge'
  }), {
    command: '/Applications/ArtiSVN.app/Contents/Resources/bridge/artisvn-mcp-bridge',
    args: []
  })

  assert.deepEqual(buildAgentClientLaunchConfig({
    platform: 'win32',
    execPath: 'C:\\Program Files\\ArtiSVN\\ArtiSVN.exe',
    launchArgs: ['--mcp-stdio'],
    mcpBridgeExeName: 'ArtiSvnMcp.exe'
  }), {
    command: 'C:\\Program Files\\ArtiSVN\\ArtiSvnMcp.exe',
    args: []
  })
})

test('client config clears ELECTRON_RUN_AS_NODE on macOS', () => {
  assert.deepEqual(buildAgentClientLaunchConfig({
    platform: 'darwin',
    execPath: '/Applications/JaviSVN.app/Contents/MacOS/JaviSVN',
    launchArgs: ['--mcp-stdio']
  }), {
    command: '/usr/bin/env',
    args: [
      '-u',
      'ELECTRON_RUN_AS_NODE',
      '/Applications/JaviSVN.app/Contents/MacOS/JaviSVN',
      '--mcp-stdio'
    ]
  })
})

test('client config clears ELECTRON_RUN_AS_NODE on Windows through cmd.exe', () => {
  assert.deepEqual(buildAgentClientLaunchConfig({
    platform: 'win32',
    execPath: 'D:\\Users\\cmmorale\\AppData\\Local\\Programs\\javisvn\\JaviSVN.exe',
    launchArgs: ['--mcp-stdio'],
    comSpec: 'C:\\Windows\\System32\\cmd.exe'
  }), {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      'set "ELECTRON_RUN_AS_NODE=" && "D:\\Users\\cmmorale\\AppData\\Local\\Programs\\javisvn\\JaviSVN.exe" "--mcp-stdio"'
    ]
  })
})

test('client config uses direct launch on other platforms', () => {
  assert.deepEqual(buildAgentClientLaunchConfig({
    platform: 'linux',
    execPath: '/opt/JaviSVN/javisvn',
    launchArgs: ['--mcp-stdio']
  }), {
    command: '/opt/JaviSVN/javisvn',
    args: ['--mcp-stdio']
  })
})
