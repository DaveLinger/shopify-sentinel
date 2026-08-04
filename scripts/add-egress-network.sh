#!/usr/bin/env bash
# Adds the shared `shopify-egress` network to every store's compose file, so any
# store can be pointed at the SOCKS5 sidecar by setting EGRESS_PROXY in its env.
#
# Joining the network is harmless on its own — a store only uses the tunnel when
# EGRESS_PROXY is set. Idempotent: re-running skips files already patched.
#
# Usage: scripts/add-egress-network.sh [--dry-run]

set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

patched=0; skipped=0

for f in docker-compose.*.yml; do
  # Skip the egress sidecar's own compose file
  [[ "$f" == "docker-compose.egress.yml" ]] && continue

  if grep -q "shopify-egress" "$f"; then
    skipped=$((skipped+1))
    continue
  fi

  if [[ $DRY -eq 1 ]]; then
    echo "would patch: $f"
    patched=$((patched+1))
    continue
  fi

  cp "$f" "$f.bak"

  # 1) Add `- shopify-egress` after each `- <name>-internal` under a service's
  #    networks list (both server and watcher reference the internal network).
  # 2) Add the top-level external network declaration under `networks:`.
  python3 - "$f" <<'PY'
import re, sys

path = sys.argv[1]
src = open(path).read()

# Service-level: every "      - <something>-internal" line gets a sibling entry
def add_service_net(m):
    indent, name = m.group(1), m.group(2)
    return f"{indent}- {name}\n{indent}- shopify-egress"

src = re.sub(r'^([ \t]+)- ([a-z0-9-]+-internal)$',
             add_service_net, src, flags=re.M)

# Top-level: insert the external declaration as the first entry under `networks:`
src = re.sub(r'^networks:\n',
             'networks:\n  shopify-egress:\n    external: true\n',
             src, count=1, flags=re.M)

open(path, 'w').write(src)
PY

  echo "patched: $f"
  patched=$((patched+1))
done

echo "---"
echo "patched: $patched   already had it: $skipped"
[[ $DRY -eq 0 ]] && echo "backups written as docker-compose.*.yml.bak"
