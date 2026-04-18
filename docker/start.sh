#!/usr/bin/env bash
set -e
docker compose -f "$(dirname "$0")/docker-compose.yml" up -d
echo "pgvector: localhost:5432"
echo "ollama:   localhost:11434"
