# ArtiSVN

Cliente de escritorio SVN para macOS y Windows inspirado en GitHub Desktop. ArtiSVN permite explorar repositorios remotos, hacer checkout, revisar cambios e historial, resolver conflictos y trabajar con SVN sin depender de la línea de comandos para el uso diario.

## Características

- Explorador remoto, búsqueda por nombre/contenido/comentarios y navegación directa al resultado.
- Historial remoto y local con diff por archivo.
- Checkout y export con progreso; commit selectivo, revert, blame y resolución de conflictos.
- Preview y descarga de archivos, apertura en Finder o editor externo.
- Integración MCP local opcional y actualizaciones desde releases de ArtiSVN.

## Requisitos

- macOS (Apple Silicon o Intel) o Windows 10/11
- Node.js 20+ y npm para desarrollo
- Subversion para regenerar el bundle: `brew install subversion` en macOS; SlikSVN o TortoiseSVN CLI en Windows

La aplicación distribuida ya incluye SVN.

## Instalación

### macOS

1. Descarga el `.dmg` desde la [última release](https://github.com/JavierValdez/ArtiSVN/releases/latest).
2. Arrastra **ArtiSVN** a **Aplicaciones**.
3. Si macOS bloquea una build sin notarizar, ejecuta:

```bash
xattr -cr /Applications/ArtiSVN.app
```

### Windows

Descarga el `.exe` desde la [última release](https://github.com/JavierValdez/ArtiSVN/releases/latest), ejecuta el instalador NSIS y abre **ArtiSVN** desde el acceso directo o el menú Inicio.

## Migración desde JaviSVN

La versión 2.2.0 adopta la identidad **ArtiSVN**: paquete npm `artisvn`, app ID `com.artisvn.app`, aplicación/instaladores `ArtiSVN` y repositorio público `JavierValdez/ArtiSVN`.

Rutas canónicas nuevas:

- configuración macOS: `~/Library/Application Support/artisvn/artisvn-config.json`
- configuración Windows: `%APPDATA%\artisvn\artisvn-config.json`
- working copies macOS: `~/Documents/ArtiSvn/`
- working copies Windows: `%USERPROFILE%\Documents\ArtiSvn\`
- bridge macOS: `/Applications/ArtiSVN.app/Contents/Resources/bridge/artisvn-mcp-bridge`
- bridge Windows: `ArtiSvnMcp.exe` dentro de la instalación de ArtiSVN

Durante la transición, ArtiSVN reconoce/importa las rutas de datos anteriores `javisvn/javisvn-config.json` y `Documents/JaviSvn`, y los paquetes incluyen los aliases `bridge/javisvn-mcp-bridge` y `JaviSvnMcp.exe`. Estos nombres legacy son compatibilidad transitoria: configura integraciones nuevas con los nombres `artisvn-*`/`ArtiSvn*`.

El canal de actualización canónico es `https://storage.googleapis.com/artictools-releases/artisvn/releases`. `https://storage.googleapis.com/artictools-releases/javisvn/releases` se mantiene temporalmente para clientes instalados con la identidad anterior; ambos reciben los mismos assets versionados y metadata `latest*.yml`.

## Integración IA por MCP

1. Abre **Integración IA** en ArtiSVN y actívala.
2. Copia la configuración generada por la aplicación en tu cliente MCP; esa es la fuente autoritativa para el endpoint y la autorización local.
3. Usa el bridge canónico `artisvn-mcp-bridge` en macOS o `ArtiSvnMcp.exe` en Windows.

`.mcp.example.json` es una plantilla sin token ni secretos. Copia su estructura si la necesitas, pero no confirmes `.mcp.json`: está ignorado porque la configuración funcional puede contener autorización local. Las URLs SVN libres usan las credenciales guardadas en ArtiSVN y no aceptan credenciales embebidas.

La integración expone catálogo de remotos/repos, `status`, `diff`, `log`, `blame`, `info`, exploración remota, búsqueda, contenido e historial. `checkout_remote` y `update_local_repo` requieren confirmación visible.

## Comandos útiles

```bash
./start.sh
npm run dev
npm run build
npm run dist
npx tsc -p tsconfig.web.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
```

`ELECTRON_RUN_AS_NODE` no debe estar definido al arrancar la app. `./start.sh` lo limpia.

Para regenerar el bundle SVN en Windows usa `ARTISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE=1`. El alias `JAVISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE=1` continúa soportado durante la migración.

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

El proyecto usa Electron 32, electron-vite 5, React 18, TypeScript y ESM obligatorio. Las operaciones SVN deben pasar por la abstracción compartida que aplica autenticación y compatibilidad TLS legacy. `resources/bin/` y `resources/lib/` forman parte del repositorio.

## Release

`.github/workflows/release.yml` se activa con tags `v*` y exige que el tag sea exactamente `v` + la versión de `package.json`. La matriz produce:

- `ArtiSVN-Mac-X.Y.Z-Installer.dmg`
- `ArtiSVN-Mac-X.Y.Z-Installer.zip`
- `ArtiSVN-Windows-X.Y.Z-Setup.exe`

El workflow publica el mismo release en GitHub y en los canales GCS `artisvn/releases` (canónico) y `javisvn/releases` (legacy). En cada canal, los instaladores y blockmaps viven bajo `vX.Y.Z/` con cache inmutable; `latest.yml` y `latest-mac.yml` permanecen en la raíz con `no-cache`. El job verifica los instaladores macOS/Windows, la metadata y sus assets en ambos canales.

Flujo:

1. Actualiza `version` en `package.json` y `package-lock.json`.
2. Commit/push según el proceso del equipo.
3. Crea y empuja el tag coincidente, por ejemplo `v2.2.0`.

```bash
git tag v2.2.0
git push origin v2.2.0
```

Fallback manual:

```bash
npm run dist
gh release create vX.Y.Z dist/* --repo JavierValdez/ArtiSVN --title "ArtiSVN vX.Y.Z"
```

Secrets de CI opcionales para firma/notarización: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. La publicación GCS requiere `GCP_RELEASES_SERVICE_ACCOUNT_KEY` en GitHub Actions; nunca se guarda en archivos del repositorio.

## Licencia

Uso personal / interno. Sin licencia de distribución pública.
