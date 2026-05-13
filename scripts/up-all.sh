#!/bin/bash
set -e
cd "$(dirname "$0")/.."

BUILD_FLAG=""
if [[ "$1" == "--build" || "$1" == "-build" ]]; then
  BUILD_FLAG="--build"
fi

for f in docker-compose.*.yml; do
  echo "==> Starting $f"
  docker compose -f "$f" up -d $BUILD_FLAG
done
