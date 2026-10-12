# Hosted pilot runbook

Operator procedure for the single hosted pilot target (Stage 12). The [release](../.codex/docs/implementation/v1.6/delivery/03-ci-cd-and-release.md) and [operations](../.codex/docs/implementation/v1.6/delivery/05-operations-and-recovery.md) handbook pages own the rules; this page is how this target follows them.

## 1. Target

- One hosted target: the Supabase project named by `SCOPEROOM_SUPABASE_PROJECT_REF` in `.env.hosted.local`, one Vercel production project, the Trigger `prod` environment. It is the pilot. Record the Vercel project, production URL, Trigger project ref, released SHA, migration head, operator and contact in the [progress tracker](context/progress-tracker.md), never credentials.
- Synthetic data and invited users only. Before any private or customer data, the private-data gate needs actual evidence: safe permanent project deletion, an isolated restore with post-backup deletion and revocation reconciliation, and a review of provider data-handling terms and operator access.

## 2. Configuration

Credentials live only in ignored `.env.hosted.local` and `.env.smoke.local` (matched by `.env*.local`) or in the provider settings below. Never paste them into evidence, the tracker, commits or chat.

Hosted Supabase signs database certificates with its own root CA. Download it from Dashboard, Project Settings, Database, SSL Configuration (`prod-ca-2021.crt`); it is public, not a secret. `pg` treats `sslmode=require` as full verification, so every database connection needs that CA.

| Variable | Where | Value |
|---|---|---|
| `SCOPEROOM_DB_TARGET` | `.env.hosted.local` | `hosted` |
| `SCOPEROOM_SUPABASE_PROJECT_REF` | `.env.hosted.local` | the 20-letter project ref |
| `SCOPEROOM_ENVIRONMENT_ID` | `.env.hosted.local`, Vercel, Trigger | a fresh UUID for this target, never a local value |
| `SCOPEROOM_BOOTSTRAP_DATABASE_URL` | `.env.hosted.local` | session pooler (IPv4, port 5432), user `postgres.<ref>`, `?sslmode=require&sslrootcert=<absolute path to the CA>` |
| `MIGRATION_DATABASE_URL` | `.env.hosted.local` | same host, port, `sslmode` and `sslrootcert` as the bootstrap URL plus `schema=app` (Prisma keeps its history in `app`), user `app_migrator_runtime.<ref>`; no other query parameters |
| `SCOPEROOM_MIGRATOR_PASSWORD`, `SCOPEROOM_WEB_RUNTIME_PASSWORD`, `SCOPEROOM_WORKER_RUNTIME_PASSWORD` | `.env.hosted.local` | fresh random values; bootstrap provisions the login roles with them |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `.env.hosted.local`, Vercel | `https://<ref>.supabase.co` and its publishable key |
| `APP_ENV`, `NEXT_PUBLIC_APP_URL` | Vercel | `production` and the bare HTTPS production origin |
| `DATABASE_URL` | Vercel | transaction pooler (port 6543), user `app_web_runtime.<ref>` |
| `WORKER_DATABASE_URL` | Trigger `prod` | transaction pooler (port 6543), user `app_worker_runtime.<ref>` |
| `SCOPEROOM_DATABASE_CA_PEM` | Vercel, Trigger `prod` | the CA file's PEM text; runtime connections then verify the server whatever TLS parameters the URL carries |
| `SCOPEROOM_REALTIME_SIGNING_ALG`, `_KEY`, `_KID` | Vercel | `ES256`, the imported key's PKCS8 PEM and its key id ([Realtime setup](realtime-setup.md)) |
| `AI_MODEL` | Vercel | the model id; empty pauses AI admission |
| `AI_TOTAL_RUN_LIMIT`, `AI_DAILY_RUN_LIMIT` | Vercel, optional | default-plan AI limits for every account; blank keeps 5 total and 30 per day |
| `TRIGGER_SECRET_KEY` | Vercel, Trigger `prod` | the Trigger `prod` runtime key (left off Vercel for the first deployment, see the 12b plan) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Trigger `prod` | the Gemini key; never on Vercel |
| `TRIGGER_ACCESS_TOKEN`, `TRIGGER_PROJECT_REF` | GitHub environment `worker-synthetic` | worker deploy credentials |
| `SMOKE_URL`, `SMOKE_{OWNER,EDITOR,VIEWER}_{EMAIL,PASSWORD}`, `SMOKE_AI` | `.env.smoke.local` | production origin, three synthetic accounts, `1` only when an AI budget is authorized |

Never set bootstrap, migrator, worker or Google credentials on Vercel.

## 3. Bootstrap and migrate

Once, on the empty target, with "Allow public access" still on in the Realtime settings:

```powershell
node --env-file=.env.hosted.local scripts/db/bootstrap.mjs
```

`guard.mjs --initial` first checks what hosted `postgres` can do. Hosted Supabase has no `supabase_admin`, and `postgres` cannot pass on Auth grants, so hosted mode differs from local in three places. `app_migrator` and `app_realtime_reader` join `anon` (no `SET`) for `auth` schema access. PUBLIC already executes `auth.uid()`, `auth.jwt()` and `realtime.send`. `guard.mjs --hosted-baseline` applies the baseline migration as `app_migrator` without its one `auth.users` foreign key, then `postgres` adds that constraint verbatim in the same transaction, and Prisma records the baseline as applied. Both database URLs accept only `sslmode`, `sslrootcert` and, for the migration URL, `schema`; anything else is refused, because pg and Prisma let query parameters override the host, port or user.

If bootstrap stops after `--hosted-baseline` committed (for example the Prisma `migrate resolve` step failed), do not rerun bootstrap: its empty-target check refuses. Finish the remaining steps by hand, in order, and stop at the first failure:

```powershell
node --env-file=.env.hosted.local node_modules/prisma/build/index.js migrate resolve --applied 20260926000000_project_baseline
node --env-file=.env.hosted.local node_modules/prisma/build/index.js migrate deploy
node --env-file=.env.hosted.local scripts/db/guard.mjs --bind
node --env-file=.env.hosted.local scripts/db/guard.mjs
node --env-file=.env.hosted.local scripts/db/realtime.mjs apply
node --env-file=.env.hosted.local scripts/db/realtime.mjs verify
```

Skip the `resolve` line if `select migration_name from app._prisma_migrations` already lists the baseline. Never let Prisma run without `schema=app`: it would create `public._prisma_migrations`, which `migrate.mjs` then refuses, and resetting this target is not allowed.

The run is expected to stop at `realtime.mjs apply` with "Hosted Realtime still allows public channels". Turn "Allow public access" off, then run `node --env-file=.env.hosted.local scripts/db/realtime.mjs verify` and expect `realtime=verify-ok`.

For later releases, before the worker deploy:

```powershell
node --env-file=.env.hosted.local scripts/db/migrate.mjs
```

Never run `db:reset` or destructive SQL against this target without a separate explicit authorization naming it. If bootstrap fails partway, stop and report; cleanup of `app`, `app_private` and the created roles needs that authorization.

## 4. Release

1. Confirm green main-push CI for the SHA (`static-unit-build`, `database-integration`, `chromium`).
2. Migrate (section 3).
3. Deploy the worker: `gh workflow run deploy-worker.yml -f environment=worker-synthetic -f sha=<sha>`.
4. Deploy the web from a clean detached worktree at the SHA. `vercel.json` turns off Git deployments, so this is the only path:

   ```powershell
   git worktree add --detach ..\scoperoom-release <sha>
   cd ..\scoperoom-release
   vercel link --yes --project <vercel project>
   vercel deploy --prod --yes -e AI_EXECUTION_BINDING=<sha>
   ```

5. `GET <origin>/api/health` returns `{"status":"ok","service":"scoperoom-ai","apiVersion":"v1"}`. Runtime logs carry `releaseId` (the SHA, or `unknown` when the CLI upload has no Git metadata; then identify the release by deployment ID).
6. `corepack pnpm test:smoke:hosted`, then record the deployment IDs and results in the tracker.

Changed environment values mean a new deployment and a new smoke.

## 5. Smoke owner AI override

The smoke owner gets a bounded override so qualification runs do not exhaust the default plan. Run as `postgres` on the session pooler (it can read `auth.users`; the migrator cannot):

```sql
insert into app.pilot_entitlement (profile_id, granted_by_operator, ai_total_run_limit, ai_daily_run_limit)
select p.id, p.id, 50, 10 from app.user_profile p join auth.users u on u.id = p.auth_user_id where u.email = '<smoke owner email>'
on conflict (profile_id) do update set ai_total_run_limit = 50, ai_daily_run_limit = 10, active = true, revoked_at = null, expires_at = null;
```

`AI_TOTAL_RUN_LIMIT` and `AI_DAILY_RUN_LIMIT` change the defaults for every account; a per-account override is the way to lift only the smoke owner. More override options are in the [Admin Dashboard plan](admin-dashboard-plan.md).

## 6. Abort and correct forward

The first release has no predecessor to roll back to.

- Pause AI: redeploy the same SHA with `-e AI_MODEL=`. Admission then answers `UNAVAILABLE`; editing stays available.
- Pause everything: pause the Vercel project.
- Then fix forward with a new SHA through the full release.

Later releases may use `vercel rollback` only to an earlier deployment whose schema and worker binding are still compatible.

## 7. Incidents

| Incident | Action on this target | Check |
|---|---|---|
| Credential or access exposure | Rotate the key in its provider, redeploy what reads it, run the smoke | Supabase API keys and database password, Vercel and Trigger environment settings |
| Bad web or worker release | Pause AI or the project (section 6), correct forward | Vercel deployments, Trigger deployments |
| Database unavailable or locked | Saves fail clearly; inspect pool and locks, reconcile through receipts | Supabase database reports and logs |
| Realtime unavailable or quota pause | Expect "Live updates delayed"; saves and status polling continue | Supabase Realtime reports |
| Worker or model outage | Runs show queued or failed with bounded attempts; manual work continues | Trigger runs, Gemini quota |
| Auth or SMTP failure | Protected operations fail while verification is unavailable; retest with an operator mailbox | Supabase Auth logs, Resend |
| Bad migration | Stop releases; inspect Prisma state, prefer a corrective forward migration | `app._prisma_migrations` |

## 8. Known limitations

- Single target: no separate qualification environment; the first qualification ran on the production URL before it was shared. An unshared URL is not access control.
- Native provider logs only; retention below the 30-day policy; no alerting beyond provider defaults.
- No app request-rate limiter for commands and invitations; Supabase Auth email limits, the account plan and the import and AI limits apply.
- Rollback has no predecessor for the first release; abort is disable plus correct forward.
- Backups are as recorded in the tracker; no restore has been performed.
- `app_migrator` and `app_realtime_reader` inherit `anon` privileges on hosted (Supabase gives `postgres` no other way to grant `auth` access).
