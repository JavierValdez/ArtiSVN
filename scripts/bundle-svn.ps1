# bundle-svn.ps1
# Copia svn.exe y sus DLLs a resources/bin/ para que la app sea autónoma en Windows.
#
# Uso: powershell -ExecutionPolicy Bypass -File scripts/bundle-svn.ps1
# Modo por defecto: usa SOLO binario interno existente en resources/bin/svn.exe
# Fallback opcional (mantenimiento): ARTISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE=1.
# JAVISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE=1 se conserva como alias transitorio.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─── Paths ────────────────────────────────────────────────────────────────────
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$destDir     = Join-Path $scriptDir '..\resources\bin'
$destDir     = [System.IO.Path]::GetFullPath($destDir)
$bundledSvn  = Join-Path $destDir 'svn.exe'

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

# ─── Preferred mode: internal bundled SVN only ───────────────────────────────
if (Test-Path $bundledSvn) {
  try {
    $ver = & $bundledSvn --version --quiet 2>$null
    Write-Host "Usando SVN interno existente: $bundledSvn"
    Write-Host "SVN $ver detectado en resources/bin (sin usar SVN del sistema)."
    exit 0
  } catch {
    Write-Warning "El SVN interno existente no es ejecutable: $bundledSvn"
  }
}

$allowSystem = (($env:ARTISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE -eq '1') -or ($env:JAVISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE -eq '1'))
if (-not $allowSystem) {
  Write-Error @"
ERROR: No existe un SVN interno válido en resources/bin/svn.exe.
Política actual: NO usar SVN del sistema para el build.

Opciones:
1) Proveer el bundle interno (svn.exe + DLLs) en resources/bin/
2) Solo para regenerar bundle local: set ARTISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE=1 y reintentar
   (JAVISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE=1 sigue disponible como alias)
"@
  exit 1
}

Write-Warning "ARTISVN_ALLOW_SYSTEM_SVN_FOR_BUNDLE=1 activo: se usará SVN del sistema para regenerar bundle interno."

# ─── Locate SVN ───────────────────────────────────────────────────────────────
$candidates = @(
  "$env:ProgramFiles\TortoiseSVN\bin\svn.exe",
  "${env:ProgramFiles(x86)}\TortoiseSVN\bin\svn.exe",
  "$env:ProgramFiles\SlikSvn\bin\svn.exe",
  "$env:ProgramFiles\CollabNet Subversion Client\svn.exe"
)

# Also try to find svn.exe in PATH
$fromPath = Get-Command svn -ErrorAction SilentlyContinue
if ($fromPath) { $candidates += $fromPath.Source }

$svnSrc = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $svnSrc) {
  Write-Error @"
ERROR: svn.exe no encontrado.
Instala TortoiseSVN desde https://tortoisesvn.net (marca 'command line client tools' durante la instalacion)
"@
  exit 1
}

Write-Host "SVN encontrado en: $svnSrc"

# ─── Copy svn.exe ─────────────────────────────────────────────────────────────
Write-Host "Copiando svn.exe..."
Copy-Item -Path $svnSrc -Destination (Join-Path $destDir 'svn.exe') -Force

# ─── Copy DLLs from the same directory ───────────────────────────────────────
$srcDir = Split-Path -Parent $svnSrc
Write-Host "Copiando DLLs desde: $srcDir"
$dlls = Get-ChildItem "$srcDir\*.dll" -ErrorAction SilentlyContinue
if ($dlls) {
  foreach ($dll in $dlls) {
    Copy-Item $dll.FullName -Destination $destDir -Force
    Write-Host "  $($dll.Name)"
  }
} else {
  Write-Host "  (no se encontraron DLLs en el directorio de svn.exe)"
}

# ─── Verify ───────────────────────────────────────────────────────────────────
try {
  $ver = & $bundledSvn --version --quiet 2>$null
  Write-Host ""
  Write-Host "SVN $ver bundleado correctamente."
  Write-Host "  Binario : resources\bin\svn.exe"
  $dllCount = (Get-ChildItem "$destDir\*.dll" -ErrorAction SilentlyContinue).Count
  Write-Host "  DLLs    : $dllCount archivos en resources\bin\"
} catch {
  Write-Error "El binario copiado no funciona: $_"
  exit 1
}
