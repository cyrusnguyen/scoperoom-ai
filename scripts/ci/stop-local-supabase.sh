#!/usr/bin/env bash
set -euo pipefail

[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "Supabase cleanup is CI-only." >&2; exit 1; }

network="scoperoom-ci-loopback"
project="scoperoom-ai"
database="supabase_db_${project}"

if docker network inspect "$network" >/dev/null 2>&1; then
  owner="$(docker network inspect --format '{{index .Labels "scoperoom.ci.owner"}}' "$network")"
  [[ "$owner" == "$project" ]] || { echo "CI network ownership check failed; leaving resources untouched." >&2; exit 1; }
else
  docker inspect "$database" >/dev/null 2>&1 && { echo "CI database exists without its owned network; leaving it untouched." >&2; exit 1; }
  exit 0
fi

if docker inspect "$database" >/dev/null 2>&1; then
  label="$(docker inspect --format '{{index .Config.Labels "com.supabase.cli.project"}}' "$database")"
  [[ "$label" == "$project" ]] || { echo "CI database ownership check failed; leaving resources untouched." >&2; exit 1; }
  docker inspect --format '{{json .NetworkSettings.Networks}}' "$database" |
    node -e 'let source="";process.stdin.on("data",chunk=>source+=chunk).on("end",()=>{if(!JSON.parse(source)["scoperoom-ci-loopback"])process.exit(1)})' ||
    { echo "CI database is outside the owned network; leaving resources untouched." >&2; exit 1; }
  corepack pnpm exec supabase stop --project-id "$project" --no-backup
fi

if docker network inspect "$network" >/dev/null 2>&1; then
  docker network rm "$network" >/dev/null
fi
