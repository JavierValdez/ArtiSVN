# ArtiSVN — AGENTS.md

Guía de referencia para agentes que trabajen en este proyecto.

## Proyecto

**ArtiSVN** (antes JaviSVN) es un cliente de escritorio SVN para macOS y Windows inspirado en GitHub Desktop. Usa Electron 44, electron-vite 5, React 18, TypeScript, ESM obligatorio y SVN CLI mediante `child_process.spawn` centralizado.

Identidad de distribución desde 2.2.1:

- package: `artisvn`
- productName: `ArtiSVN`
- appId: `com.artisvn.app`
- GitHub: `https://github.com/JavierValdez/ArtiSVN`
- updates: `https://storage.googleapis.com/artictools-releases/artisvn/releases`

## Rutas y migración

Rutas canónicas:

- repos: `~/Documents/ArtiSVN/` (macOS) o `%USERPROFILE%\Documents\ArtiSVN\` (Windows)
- config: `~/Library/Application Support/artisvn/artisvn-config.json` o `%APPDATA%\artisvn\artisvn-config.json`
- bridge macOS: `ArtiSVN.app/Contents/Resources/bridge/artisvn-mcp-bridge`
- bridge Windows: `ArtiSvnMcp.exe`

La migración conserva lectura/importación de `Documents/JaviSvn` y `javisvn/javisvn-config.json`. Los paquetes incluyen temporalmente `javisvn-mcp-bridge` y `JaviSvnMcp.exe`; no los uses en configuraciones nuevas. `.mcp.json` puede contener autorización local y está ignorado. `.mcp.example.json` no contiene tokens.

## Comandos

```bash
./start.sh
npm run dev
npm run build
npm run dist
npx tsc -p tsconfig.web.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npm test
npm run check   # typecheck (main + renderer) + tests
```

Node 22.12+ es requerido por las herramientas de Electron 44. No uses `npx tsc --noEmit` en la raíz como validación única: el proyecto usa referencias. Nunca arranques con `ELECTRON_RUN_AS_NODE` definido.

## Arquitectura

```text
src/
├── main/
│   ├── index.ts
│   ├── agent/
│   ├── services/
│   └── updater.ts
├── preload/index.ts
└── renderer/src/
```

Reglas críticas:

1. ESM es obligatorio (`"type": "module"`).
2. Conserva `fixCjsShimPlugin` (introducido para Electron 32; sigue siendo inocuo en 44). El preload se compila a CommonJS (`index.cjs`) porque el renderer usa `sandbox: true`.
3. Importa `xml2js` mediante `createRequire`.
4. Las operaciones SVN deben usar `runSvn()`/`spawnSvn()`: contraseña por stdin (`--password-from-stdin`, nunca `--password`), credenciales ligadas al origen, TLS estricto salvo el perfil `legacy-sat` del host exacto `linrepo00.sat-interno.gob.gt`/`linrepo00` (`src/main/services/svn-policy.ts`), locale y progreso. Pon `--` antes de los targets.
8. Registra los handlers IPC con `handleTrusted()` (`src/main/ipc/guard.ts`) y valida `repoPath` con `assertManagedRepoPath()` y rutas de archivo con `resolvePhysicalRepoTarget()` (contención física frente a symlinks/junctions).
9. El commit y el revert pasan por `src/main/services/commit.ts` (selección estricta, `--depth empty`, `--targets`). No vuelvas a pasar carpetas recursivas a `svn commit`.
10. `--ignore-externals` es obligatorio en checkout/update/export/switch (lo añade `svn-policy.ts`, también sin credenciales). No lo retires para quitar el aviso: el CLI reenviaría la credencial a servidores de externals. El aviso al usuario sale de `services/externals.ts`.
11. `svn:setBinPath` solo acepta `auto`; un binario propio se elige únicamente con `svn:pickBinPath` (diálogo nativo en main).
12. Las credenciales se guardan por origen (`credentialsByOrigin`); `creds:update` sin contraseña solo reutiliza la clave del mismo usuario y origen (`credential-update.ts`). El renderer nunca recibe la contraseña.
5. `resources/bin/` y `resources/lib/` están versionados.
6. La detección de checkouts se basa en la URL real de `svn info`, no en nombres de carpeta.
7. Al regenerar el bundle en Windows, la variable canónica es `ARTISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE=1`; conserva `JAVISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE=1` como alias de transición.

## MCP y compatibilidad de bridge

El artefacto canónico empaquetado es `bridge/artisvn-mcp-bridge` en macOS y `ArtiSvnMcp.exe` en Windows. Mientras existan clientes JaviSVN, empaqueta también `bridge/javisvn-mcp-bridge` y `JaviSvnMcp.exe`. No copies tokens a documentación, fixtures ni ejemplos; la configuración funcional debe generarla la app.

## Release 2.2+

El workflow `.github/workflows/release.yml`:

1. valida que el tag sea `v${package.json.version}`;
2. construye DMG/ZIP macOS y NSIS Windows con nombres ArtiSVN;
3. publica todos los assets en `JavierValdez/ArtiSVN` mediante GitHub Releases;
4. publica assets versionados y metadata mutable en GCS canónico `artisvn/releases`;
5. replica el mismo contenido al canal legacy `javisvn/releases`;
6. verifica DMG, ZIP, EXE, `latest.yml`, `latest-mac.yml` y sus referencias en ambos canales.

Los assets versionados van en `vX.Y.Z/` con cache inmutable. La metadata `latest*.yml` va en la raíz con `no-cache`. No retires el canal legacy ni los aliases hasta una migración explícita posterior.

## API principal

`window.svn` expone credenciales/remotos, repos locales, exploración y búsqueda remota, checkout/export, status/diff/log/blame/info, commit/revert/resolve y utilidades de diálogo. Los eventos push incluyen progreso de checkout/update/install/search/export. `window.appUpdate` mantiene la API de estado/check/download; `window.agentIntegration` gestiona MCP.

## Recordatorios

- Mantén URLs normalizadas: navegación de resultados y badge local dependen de ello.
- `svn:version` usa `skipAuth: true`.
- Los archivos no versionados seleccionados se agregan con `svn add --force --parents` antes del commit.
- Los cambios remotos fuera del scope se muestran con badge `Fuera`.
- No incluyas secretos ni leas/confirmes `.mcp.json`.
