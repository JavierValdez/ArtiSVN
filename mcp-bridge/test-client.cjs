// Test/diagnostic client for the MCP bridge.
//
// Usage:
//   set ARTISVN_MCP_TOKEN=<token-from-app>
//   node mcp-bridge/test-client.cjs <path-to-bridge.exe-or-bundle.cjs>
//
// Sends an MCP `initialize` and `tools/list` and prints the responses.
// Useful to validate the bridge end-to-end without involving a real MCP client.

const { spawn } = require('node:child_process');

const exePath = process.argv[2];
const args = process.argv.slice(3);

if (!exePath) {
  console.error('Usage: node test-client.cjs <bridge-exe-path> [extra args]');
  process.exit(2);
}

const token = process.env.ARTISVN_MCP_TOKEN ?? process.env.JAVISVN_MCP_TOKEN;
if (!token) {
  console.error('Missing ARTISVN_MCP_TOKEN env var. Copy it from the app (Integracion IA settings).');
  process.exit(2);
}

const child = spawn(exePath, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ARTISVN_MCP_TOKEN: token,
    ARTISVN_MCP_DEBUG: '1',
    // Simulate Electron-based MCP clients (Kiro CLI, Claude Desktop) that
    // inherit ELECTRON_RUN_AS_NODE=1 to their child processes. The bridge
    // must work regardless because it is plain Node, not Electron.
    ELECTRON_RUN_AS_NODE: '1',
  },
});

let stdoutBuf = '';
let nextId = 1;
const pending = new Map();

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf-8');
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      console.log('<- STDOUT:', JSON.stringify(msg).slice(0, 250));
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (e) {
      console.log('<- STDOUT(no-json):', line.slice(0, 200));
    }
  }
});

child.stderr.on('data', (chunk) => {
  process.stderr.write('[child stderr] ' + chunk.toString());
});

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  console.log('-> REQUEST:', JSON.stringify(msg).slice(0, 250));
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }
    }, 8000);
  });
}

function sendNotification(method, params) {
  const msg = { jsonrpc: '2.0', method, params };
  console.log('-> NOTIFY:', JSON.stringify(msg).slice(0, 200));
  child.stdin.write(JSON.stringify(msg) + '\n');
}

(async () => {
  try {
    await new Promise((r) => setTimeout(r, 500));
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    });
    console.log('--- INITIALIZE OK ---');
    sendNotification('notifications/initialized', {});
    await new Promise((r) => setTimeout(r, 200));
    const tools = await send('tools/list', {});
    console.log('--- TOOLS LIST OK ---');
    console.log('Number of tools:', (tools.result?.tools || []).length);
    console.log('Tool names:', (tools.result?.tools || []).map((t) => t.name).join(', '));
    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exit(1);
  } finally {
    child.kill();
  }
})();
