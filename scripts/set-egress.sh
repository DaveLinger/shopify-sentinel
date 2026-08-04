#!/usr/bin/env bash
# Sets or clears EGRESS_PROXY across store env files.
#
# Only meaningful once the sidecar is running:
#   docker compose -f docker-compose.egress.yml up -d
#
# Setting it on a store with no sidecar running is safe but pointless — every
# request will fail the tunnel and fall back to direct, just with extra latency.
#
# Usage:
#   scripts/set-egress.sh on              # all stores -> socks5h://shopify-egress:1055
#   scripts/set-egress.sh on hiproof tipxy  # only these stores
#   scripts/set-egress.sh off             # remove EGRESS_PROXY everywhere
#   scripts/set-egress.sh status          # show current state

set -euo pipefail
cd "$(dirname "$0")/.."

PROXY="socks5h://shopify-egress:1055"
MODE="${1:-status}"; shift || true

envs=()
if [[ $# -gt 0 ]]; then
  for s in "$@"; do
    [[ -f "$s.env" ]] || { echo "no such store env: $s.env" >&2; exit 1; }
    envs+=("$s.env")
  done
else
  for f in *.env; do [[ "$f" == "egress.env" ]] && continue; envs+=("$f"); done
fi

case "$MODE" in
  on)
    for f in "${envs[@]}"; do
      if grep -q "^EGRESS_PROXY=" "$f"; then
        sed -i "s|^EGRESS_PROXY=.*|EGRESS_PROXY=$PROXY|" "$f"
      else
        printf '\n# Route Shopify fetches through the Tailscale exit node (see CLAUDE.md)\nEGRESS_PROXY=%s\n' "$PROXY" >> "$f"
      fi
      echo "on:  ${f%.env}"
    done
    echo "--- restart affected stores for this to take effect ---"
    ;;
  off)
    for f in "${envs[@]}"; do
      sed -i "/^EGRESS_PROXY=/d; /^# Route Shopify fetches through the Tailscale exit node/d" "$f"
      echo "off: ${f%.env}"
    done
    echo "--- restart affected stores for this to take effect ---"
    ;;
  status)
    on=0; off=0
    for f in "${envs[@]}"; do
      if grep -q "^EGRESS_PROXY=" "$f"; then on=$((on+1)); else off=$((off+1)); fi
    done
    echo "proxied: $on   direct: $off   (of ${#envs[@]} stores)"
    ;;
  *)
    echo "usage: $0 {on|off|status} [store ...]" >&2; exit 1
    ;;
esac
