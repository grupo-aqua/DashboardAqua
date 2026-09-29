#!/bin/sh
# scripts/deploy-mcp-server.sh
# Reconstruye y redespliega mcp_server horneando el commit/rama/fecha de
# build actuales en la imagen (ver mcp-server/Dockerfile,
# docker-compose.yml) — para poder confirmar qué código corre en el
# droplet con `curl localhost:8787/health` (o desde afuera, según la
# exposición real del puerto) en vez de tener que hacer
# `docker exec ... git rev-parse HEAD` + grep manual cada vez.
#
# Uso: ./scripts/deploy-mcp-server.sh   (desde cualquier directorio)
set -e
cd "$(dirname "$0")/.."

export GIT_COMMIT="$(git rev-parse HEAD)"
export GIT_BRANCH="$(git branch --show-current)"
export BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Desplegando mcp_server — commit=$GIT_COMMIT branch=$GIT_BRANCH build_date=$BUILD_DATE"

docker compose build mcp_server
docker compose up -d mcp_server

echo "Listo. Verificar con: curl -s http://localhost:8787/health (o docker exec mcp_server wget -qO- http://localhost:8787/health)"
