# ArtiSVN MCP bridge

Standalone Node.js bridge that exposes the ArtiSVN MCP surface over stdio.

## Why this exists

The Electron GUI executable uses the Windows `WINDOWS_GUI` subsystem. That has
two consequences for MCP stdio:

1. The GUI executable does not propagate stdin/stdout functionally to a console
   MCP client.
2. Electron-based MCP clients may pass `ELECTRON_RUN_AS_NODE=1` to children. An
   empty override does not reliably unset it on Windows.

The standalone bridge avoids both issues. On macOS/Linux the generated launcher
runs the same bundled bridge with Node.

## Compatibility

- Canonical MCP server name: `artisvn`
- Canonical environment prefix: `ARTISVN_*`
- Legacy `JAVISVN_*` variables remain accepted; when both are present,
  `ARTISVN_*` wins.
- Canonical resources use `artisvn://`; `javisvn://` remains registered as an
  alias.
- The broker endpoint deliberately remains `\\.\pipe\javisvn-agent-broker` on
  Windows (and `javisvn-agent-broker.sock` on Unix) so previously installed
  bridges continue to connect.

Tool and broker method names are unchanged.

## Build

```bash
# Bundle only:
npm run build:mcp-bridge:bundle

# Bundle plus platform bridge artifacts:
npm run build:mcp-bridge
```

Outputs go to `dist-mcp-bridge/`:

- `bridge.cjs` — bundled JavaScript
- Windows: `ArtiSvnMcp.exe` plus legacy alias `JaviSvnMcp.exe`
- macOS/Linux: `artisvn-mcp-bridge` plus legacy alias
  `javisvn-mcp-bridge`

## Test locally

```powershell
# Keep the GUI app open with "Integracion IA" enabled.
$env:ARTISVN_MCP_TOKEN = "<token from the app>"
node mcp-bridge\test-client.cjs dist-mcp-bridge\ArtiSvnMcp.exe
```

Expected output includes `INITIALIZE OK` and `TOOLS LIST OK`.

## MCP client sample (Windows)

New configurations use the canonical identity:

```json
{
  "mcpServers": {
    "artisvn": {
      "command": "C:\\Users\\<user>\\AppData\\Local\\Programs\\artisvn\\ArtiSvnMcp.exe",
      "args": [],
      "env": {
        "ARTISVN_MCP_TOKEN": "<token>"
      }
    }
  }
}
```

The legacy executable and environment names continue to work for existing
client configurations.
