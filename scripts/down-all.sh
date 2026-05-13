#!/bin/bash
set -e
cd "$(dirname "$0")/.."

for f in docker-compose.*.yml; do
  echo "==> Stopping $f"
  docker compose -f "$f" down
done
