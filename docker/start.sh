#!/usr/bin/env bash
set -e

DIR="$(dirname "$0")"
COMPOSE_FILES="-f $DIR/docker-compose.yml"

if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null 2>&1; then
  echo "NVIDIA GPU detected — enabling GPU passthrough for Ollama"
  COMPOSE_FILES="$COMPOSE_FILES -f $DIR/docker-compose.gpu.yml"
fi

docker compose $COMPOSE_FILES up -d
echo "pgvector: localhost:5432"
echo "ollama:   localhost:11434"
