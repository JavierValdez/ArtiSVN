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
- Node.js 22.12+ y npm para desarrollo (requisito de las herramientas de Electron 44)
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

La versión 2.2.1 adopta la identidad **ArtiSVN**: paquete npm `artisvn`, app ID `com.artisvn.app`, aplicación/instaladores `ArtiSVN` y repositorio público `JavierValdez/ArtiSVN`.

Rutas canónicas nuevas:

- configuración macOS: `~/Library/Application Support/artisvn/artisvn-config.json`
- configuración Windows: `%APPDATA%\artisvn\artisvn-config.json`
- working copies macOS: `~/Documents/ArtiSVN/`
- working copies Windows: `%USERPROFILE%\Documents\ArtiSVN\`
- bridge macOS: `/Applications/ArtiSVN.app/Contents/Resources/bridge/artisvn-mcp-bridge`
- bridge Windows: `ArtiSvnMcp.exe` dentro de la instalación de ArtiSVN

Durante la transición, ArtiSVN reconoce/importa las rutas de datos anteriores `javisvn/javisvn-config.json` y `Documents/JaviSvn`, y los paquetes incluyen los aliases `bridge/javisvn-mcp-bridge` y `JaviSvnMcp.exe`. Estos nombres legacy son compatibilidad transitoria: configura integraciones nuevas con los nombres `artisvn-*`/`ArtiSvn*`.

El canal de actualización canónico es `https://storage.googleapis.com/artictools-releases/artisvn/releases`. `https://storage.googleapis.com/artictools-releases/javisvn/releases` se mantiene temporalmente para clientes instalados con la identidad anterior; ambos reciben los mismos assets versionados y metadata `latest*.yml`.

## Integración IA por MCP

1. Abre **Integración IA** en ArtiSVN y actívala.
2. Copia la configuración generada por la aplicación en tu cliente MCP; esa es la fuente autoritativa para el endpoint y la autorización local.
3. Usa el bridge canónico `artisvn-mcp-bridge` en macOS o `ArtiSvnMcp.exe` en Windows.

La pantalla de Integración IA muestra el token oculto; el botón **Copiar** lo copia desde el proceso principal sin exponerlo al renderer. Las herramientas MCP con `url` libre solo aceptan servidores de remotos o credenciales configurados en ArtiSVN.

`.mcp.example.json` es una plantilla sin token ni secretos. Copia su estructura si la necesitas, pero no confirmes `.mcp.json`: está ignorado porque la configuración funcional puede contener autorización local. Las URLs SVN libres usan las credenciales guardadas en ArtiSVN y no aceptan credenciales embebidas.

La integración expone catálogo de remotos/repos, `status`, `diff`, `log`, `blame`, `info`, exploración remota, búsqueda, contenido e historial. `checkout_remote` y `update_local_repo` requieren confirmación visible.

## Comandos útiles

```bash
./start.sh
npm run dev
npm run build
npm run dist
npm run check        # tsc main + renderer y tests
npx tsc -p tsconfig.web.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
```

`ELECTRON_RUN_AS_NODE` no debe estar definido al arrancar la app. `./start.sh` lo limpia.

Si el repositorio está en una carpeta sincronizada con iCloud, pueden aparecer duplicados `node_modules/** 2` que rompen `tsc`. Valida en una copia limpia fuera de iCloud (`npm ci`). Para pruebas manuales sin tocar la configuración personal, en `npm run dev` se puede aislar con `ARTISVN_DEV_APPDATA_DIR=<tmp>/appdata ARTISVN_DEV_DOCUMENTS_DIR=<tmp>/Documents` sin tocar `HOME` (ambas se ignoran en la app empaquetada).

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

El proyecto usa Electron 44, electron-vite 5, React 18, TypeScript y ESM obligatorio (el preload se compila a CommonJS porque el renderer corre con `sandbox: true`). Las operaciones SVN deben pasar por `runSvn()`/`spawnSvn()` (`src/main/services/svn-runtime.ts`), que aplica la política de credenciales y TLS por origen. Los handlers IPC viven en `src/main/ipc/*` y validan el emisor. `resources/bin/` y `resources/lib/` forman parte del repositorio.

## Seguridad SVN: credenciales y TLS por origen

- La contraseña nunca va en argv: se envía por stdin con `--password-from-stdin` (SVN 1.14).
- Las credenciales quedan ligadas al origen (`https://host:puerto`) con el que se guardaron y solo se envían a ese origen; nunca por `http://`. `linrepo00` y `linrepo00.sat-interno.gob.gt` cuentan como el mismo servidor.
- `svn:externals` **siempre se omiten** en checkout, update, export y switch (`--ignore-externals`), con o sin credenciales. El CLI de SVN ofrecería la credencial del servidor principal a cualquier servidor referenciado por un external. Tras un checkout o update, ArtiSVN revisa la copia local (sin red) y avisa en el progreso y con un aviso informativo cuántas definiciones no se descargaron; en exportaciones el aviso es genérico. Si necesitas un external, haz checkout de su URL por separado: esa operación usa las credenciales y la política TLS de su propio origen.
- TLS estricto para todo origen, salvo el SVN legado de SAT: solo `linrepo00.sat-interno.gob.gt` y su alias `linrepo00` (sin comodines) usan el perfil `legacy-sat`: OpenSSL con TLSv1/SECLEVEL=0/renegociación legacy y aceptación de `unknown-ca`, `expired`, `not-yet-valid`, `other` (más `cn-mismatch` solo para el alias). Verificado de forma anónima el 27-oct-2026: el servidor solo negocia TLSv1.0 `DHE-RSA-AES256-SHA`, sin renegociación segura, con certificado vencido en 2018 emitido por `APCEISSUECA01-CA`.
- Excepciones explícitas por origen exacto: clave `svnTlsPolicies` del archivo de configuración, por ejemplo `{"https://otro.host:443": "legacy-sat"}` o `"strict"`.
- Límite conocido: con el perfil legacy no se puede verificar la identidad del servidor SAT (certificado vencido de CA interna no distribuida). La mitigación es acotar la excepción al host exacto.
- Binario SVN propio: solo se puede elegir con el selector nativo de archivos del proceso principal (`svn:pickBinPath`; la interfaz actual no lo expone y usa el binario incluido o `auto`). `svn:setBinPath` desde el renderer solo acepta volver a `auto`; no admite rutas escritas, para que una página comprometida no pueda apuntar a un ejecutable descargado en un checkout.

## Actualizaciones de la app

El updater solo descarga por HTTPS desde hosts permitidos (GitHub y `storage.googleapis.com`), valida cada redirección y verifica tamaño y checksum (SHA-512 del metadata de electron-builder o digest SHA-256 de GitHub) antes de renombrar el instalador. Un instalador ya descargado se vuelve a verificar antes de reutilizarse. El checksum viene del mismo canal de publicación: detecta corrupción o archivos cambiados, pero no autentica al publicador. Los instaladores aún no están firmados y la instalación sigue siendo manual.

## CI

`.github/workflows/ci.yml` corre en push y pull request: `npm ci`, `tsc` de main y renderer, `npm test` (incluye pruebas de integración con `svnadmin`/`svnserve`) y `electron-vite build`. El workflow de release depende de este gate. La matriz es ubuntu, macOS y Windows, y las tres bloquean: si cualquiera falla, no hay release. La matriz Windows está configurada pero aún no se ha ejecutado en GitHub Actions; el primer push lo validará.

## Release

`.github/workflows/release.yml` se activa con tags `v*` y exige que el tag sea exactamente `v` + la versión de `package.json`. La matriz produce:

- `ArtiSVN-Mac-X.Y.Z-Installer.dmg`
- `ArtiSVN-Mac-X.Y.Z-Installer.zip`
- `ArtiSVN-Windows-X.Y.Z-Setup.exe`

El workflow publica el mismo release en GitHub y en los canales GCS `artisvn/releases` (canónico) y `javisvn/releases` (legacy). En cada canal, los instaladores y blockmaps viven bajo `vX.Y.Z/` con cache inmutable; `latest.yml` y `latest-mac.yml` permanecen en la raíz con `no-cache`. El job verifica los instaladores macOS/Windows, la metadata y sus assets en ambos canales.

Flujo:

1. Actualiza `version` en `package.json` y `package-lock.json`.
2. Commit/push según el proceso del equipo.
3. Crea y empuja el tag coincidente, por ejemplo `v2.2.1`.

```bash
git tag v2.2.1
git push origin v2.2.1
```

Fallback manual:

```bash
npm run dist
gh release create vX.Y.Z dist/* --repo JavierValdez/ArtiSVN --title "ArtiSVN vX.Y.Z"
```

Secrets de CI opcionales para firma/notarización: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. La publicación GCS requiere `GCP_RELEASES_SERVICE_ACCOUNT_KEY` en GitHub Actions; nunca se guarda en archivos del repositorio.

## Licencia

Uso personal / interno. Sin licencia de distribución pública.
