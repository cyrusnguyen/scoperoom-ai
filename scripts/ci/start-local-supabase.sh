#!/usr/bin/env bash
set -euo pipefail

network="scoperoom-ci-loopback"
log="${RUNNER_TEMP:-/tmp}/scoperoom-supabase-start.log"

if docker network inspect "$network" >/dev/null 2>&1; then
  owner="$(docker network inspect --format '{{index .Labels "scoperoom.ci.owner"}}' "$network")"
  [[ "$owner" == "scoperoom-ai" ]] || { echo "CI network ownership check failed." >&2; exit 1; }
else
  docker network create --driver bridge --label scoperoom.ci.owner=scoperoom-ai --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$network" >/dev/null
fi
if ! corepack pnpm exec supabase start --network-id "$network" --exclude vector --ignore-health-check >"$log" 2>&1; then
  sed -E -n '/(error|fail|health|timeout)/I{s#(postgres(ql)?://)[^[:space:]]+#\1[redacted]#Ig;s#(key|password|token|secret)[[:space:]]*[:=][[:space:]]*[^[:space:]]+#\1=[redacted]#Ig;p;}' "$log"
  exit 1
fi

docker ps --filter 'label=com.supabase.cli.project=scoperoom-ai' --format '{{.Names}} {{.Status}} {{.Ports}}'