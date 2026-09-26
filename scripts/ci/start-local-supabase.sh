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

publishable="$(corepack pnpm exec supabase status --output json | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).PUBLISHABLE_KEY || "")')"
ready=0
for attempt in $(seq 1 60); do
  if docker exec supabase_db_scoperoom-ai pg_isready -U postgres -q && curl -fsS -o /dev/null -H "apikey: ${publishable}" http://127.0.0.1:54321/auth/v1/health; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  echo "Local Supabase database or Auth did not become ready within 120 seconds." >&2
  bash "$(dirname "$0")/print-local-supabase-logs.sh"
  exit 1
fi