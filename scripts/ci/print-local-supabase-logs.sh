#!/usr/bin/env bash
set -uo pipefail

for container in supabase_db_scoperoom-ai supabase_auth_scoperoom-ai; do
  if [[ "$container" == supabase_auth_* ]]; then
    lines=$(docker logs --tail 80 "$container" 2>&1 | wc -l | tr -d ' ')
    printf '== %s (Auth log details suppressed; %s lines)\n' "$container" "${lines:-0}"
  else
    echo "== ${container} (last 80 lines, redacted)"
    docker logs --tail 80 "$container" 2>&1 | sed -E 's#(postgres(ql)?://)[^[:space:]]+#\1[redacted]#Ig;s#(key|password|token|secret)[[:space:]]*[:=][[:space:]]*[^[:space:]]+#\1=[redacted]#Ig'
  fi
done
