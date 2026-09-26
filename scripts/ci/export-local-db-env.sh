#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_ENV:?GitHub Actions provides GITHUB_ENV for CI-only local database settings.}"
pooler="supabase_pooler_scoperoom-ai"
if docker exec "$pooler" test -f /app/pooler_tenant.exs; then
  tenant_source="$(docker exec "$pooler" cat /app/pooler_tenant.exs)"
else
  tenant_source="$(docker inspect --format '{{json .Config.Cmd}}' "$pooler" | node -e 'const source=require("node:fs").readFileSync(0,"utf8");process.stdout.write(JSON.parse(source).join("\n"))')"
fi
tenant="$(node -e 'const source=require("node:fs").readFileSync(0,"utf8");const match=source.match(/"external_id"\s*=>\s*"([a-zA-Z0-9_-]+)"/);if(!match)process.exit(1);process.stdout.write(match[1])' <<<"$tenant_source")"
[[ "$tenant" =~ ^[a-zA-Z0-9_-]+$ ]]

cat >>"$GITHUB_ENV" <<EOF
SCOPEROOM_BOOTSTRAP_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
MIGRATION_DATABASE_URL=postgresql://app_migrator_runtime:postgres@127.0.0.1:54322/postgres?schema=app
DATABASE_URL=postgresql://app_web_runtime.${tenant}:postgres@127.0.0.1:54329/postgres
WORKER_DATABASE_URL=postgresql://app_worker_runtime.${tenant}:postgres@127.0.0.1:54329/postgres
E2E_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
SCOPEROOM_ENVIRONMENT_ID=a2f5fe03-b7ea-4331-bfc8-3907f01d3528
SCOPEROOM_MIGRATOR_PASSWORD=postgres
SCOPEROOM_WEB_RUNTIME_PASSWORD=postgres
SCOPEROOM_WORKER_RUNTIME_PASSWORD=postgres
SCOPEROOM_DOCKER_BIN=docker
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3101
EOF
