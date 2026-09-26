#!/usr/bin/env bash
set -uo pipefail

for container in supabase_db_scoperoom-ai supabase_auth_scoperoom-ai; do
  echo "== ${container} (last 80 lines, redacted)"
  docker logs --tail 80 "$container" 2>&1 | sed -E 's#(postgres(ql)?://)[^[:space:]]+#\1[redacted]#Ig;s#(key|password|token|secret)[[:space:]]*[:=][[:space:]]*[^[:space:]]+#\1=[redacted]#Ig'
done
