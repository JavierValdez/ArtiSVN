# CLAUDE.md

Guidance for Claude Code when working in **ArtiSVN** (formerly JaviSVN), an Electron + React desktop SVN client for macOS and Windows.

## Commands

```bash
./start.sh
npm run dev
npm run build
npm run dist
npx tsc -p tsconfig.web.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
```

Never set `ELECTRON_RUN_AS_NODE`. Root `npx tsc --noEmit` is not sufficient because the project uses TypeScript references.

## Distribution identity and migration

Version 2.2.0 uses package `artisvn`, product `ArtiSVN`, app ID `com.artisvn.app`, and GitHub repository `JavierValdez/ArtiSVN`. Canonical data paths are `~/Library/Application Support/artisvn/artisvn-config.json` and `~/Documents/ArtiSvn/` on macOS, with `%APPDATA%\artisvn\artisvn-config.json` and `%USERPROFILE%\Documents\ArtiSvn\` on Windows.

Migration support imports/recognizes the old `javisvn/javisvn-config.json` and `Documents/JaviSvn` locations. New MCP integrations use `bridge/artisvn-mcp-bridge` (macOS) or `ArtiSvnMcp.exe` (Windows); packages temporarily retain `javisvn-mcp-bridge` and `JaviSvnMcp.exe`. Do not remove legacy aliases or `JAVISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE` until compatibility is intentionally retired. The canonical bundle flag is `ARTISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE`.

`.mcp.json` is ignored and must never be read, documented with real values, or committed. `.mcp.example.json` is intentionally token-free.

## Architecture

- Main (`src/main/`) owns SVN CLI, file I/O, storage, agent broker, and IPC.
- Preload (`src/preload/index.ts`) exposes `window.svn`, `window.appUpdate`, and `window.agentIntegration` through `contextBridge`.
- Renderer (`src/renderer/src/`) is the React 18 UI.

All SVN operations must use the shared `runSvn()` abstraction so stored auth, legacy TLS fallback, locale, PATH, and streaming callbacks remain consistent. URL normalization is load-bearing for search navigation and local checkout detection. Local detection uses the actual `svn info --xml` URL, not folder names.

Critical constraints:

1. Keep `"type": "module"`.
2. Keep `fixCjsShimPlugin` for Electron 32.
3. Load CommonJS `xml2js` with `createRequire(import.meta.url)`.
4. `resources/bin/` and `resources/lib/` are committed bundle inputs.
5. Validate both `tsconfig.web.json` and `tsconfig.node.json`.

## Release workflow

`.github/workflows/release.yml` runs for `v*`, rejects a tag that is not exactly `v${package.json.version}`, and creates:

- `ArtiSVN-Mac-X.Y.Z-Installer.dmg`
- `ArtiSVN-Mac-X.Y.Z-Installer.zip`
- `ArtiSVN-Windows-X.Y.Z-Setup.exe`

It publishes the GitHub Release to `JavierValdez/ArtiSVN`, then sends the same release to two GCS update channels:

- canonical: `https://storage.googleapis.com/artictools-releases/artisvn/releases`
- legacy: `https://storage.googleapis.com/artictools-releases/javisvn/releases`

Both channels hold immutable assets under `vX.Y.Z/` and mutable, no-cache `latest*.yml` at their root. CI verifies macOS and Windows installers plus metadata-referenced assets in both channels. Optional signing/notarization secrets stay in GitHub Actions; GCS uses `GCP_RELEASES_SERVICE_ACCOUNT_KEY`. Never put secret values in repository files.

Fallback:

```bash
npm run dist
gh release create vX.Y.Z dist/* --repo JavierValdez/ArtiSVN --title "ArtiSVN vX.Y.Z"
```

## Known pitfalls

- `svn --version` must use `skipAuth: true`.
- New SVN operations must not bypass `runSvn()` or legacy servers may fail.
- Search/tree URLs must stay normalized.
- Unversioned selected files are auto-added with `svn add --force --parents`.
- Remote log entries outside the selected scope are expected and shown as `Fuera`.
