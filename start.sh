#!/bin/bash
# ArtiSVN - Cliente SVN estilo GitHub Desktop
# Ejecutar este script para iniciar la aplicación

set -e
cd "$(dirname "$0")"

# Load optional local environment overrides. ARTISVN_* is canonical;
# JAVISVN_* remains a temporary compatibility alias.
if [ -f ".env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . ".env.local"
  set +a
fi

if [ -z "${ARTISVN_SVN_BIN:-}" ] && [ -n "${JAVISVN_SVN_BIN:-}" ]; then
  export ARTISVN_SVN_BIN="${JAVISVN_SVN_BIN}"
fi

if [ ! -d "node_modules/electron" ]; then
  echo "Instalando dependencias npm..."
  npm install
fi

if [ ! -f "resources/bin/svn" ]; then
  echo "Empaquetando SVN dentro de la aplicación (solo la primera vez)..."
  bash scripts/bundle-svn.sh
fi

echo "Iniciando ArtiSVN..."
if [ -n "${ARTISVN_SVN_BIN:-}" ]; then
  echo "Usando cliente SVN personalizado: ${ARTISVN_SVN_BIN}"
  # Keep the legacy name available while runtime consumers migrate.
  export JAVISVN_SVN_BIN="${JAVISVN_SVN_BIN:-${ARTISVN_SVN_BIN}}"
fi
unset ELECTRON_RUN_AS_NODE
npm run dev
