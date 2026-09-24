#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_ENV:?GitHub Actions provides GITHUB_ENV for CI-only auth settings.}"
status="$(corepack pnpm exec supabase status --output json)"
SCOPEROOM_STATUS_JSON="$status" node - "$GITHUB_ENV" <<'NODE'
const { appendFileSync } = require('node:fs');
const status = JSON.parse(process.env.SCOPEROOM_STATUS_JSON);
if (status.API_URL !== 'http://127.0.0.1:54321' || status.MAILPIT_URL !== 'http://127.0.0.1:54324' || !status.PUBLISHABLE_KEY || !status.SECRET_KEY) {
  throw new Error('Expected fresh local Supabase Auth settings.');
}
appendFileSync(process.argv[2], [
  `NEXT_PUBLIC_SUPABASE_URL=${status.API_URL}`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${status.PUBLISHABLE_KEY}`,
  `E2E_SUPABASE_URL=${status.API_URL}`,
  `E2E_SUPABASE_SECRET_KEY=${status.SECRET_KEY}`,
  `E2E_MAILPIT_URL=${status.MAILPIT_URL}`,
].join('\n') + '\n');
NODE
