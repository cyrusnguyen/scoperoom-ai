# Hosted pilot runbook

Operator procedure for the single hosted pilot target (Stage 12). The [release](../.codex/docs/implementation/v1.6/delivery/03-ci-cd-and-release.md) and [operations](../.codex/docs/implementation/v1.6/delivery/05-operations-and-recovery.md) handbook pages own the rules; this page is how this target follows them.

## 1. Target

- One hosted target: the Supabase project named by `SCOPEROOM_SUPABASE_PROJECT_REF` in `.env.hosted.local`, one Vercel web project and one Vercel worker project (same repository, Production environment), and one Inngest app. It is the pilot. Record the Vercel projects, production URLs, released SHA, migration head, operator and contact in the [progress tracker](context/progress-tracker.md), never credentials.
- Synthetic data and invited users only. Before any private or customer data, the private-data gate needs actual evidence: safe permanent project deletion, an isolated restore with post-backup deletion and revocation reconciliation, and a review of provider data-handling terms and operator access.

## 2. Configuration

Credentials live only in ignored `.env.hosted.local` and `.env.smoke.local` (matched by `.env*.local`) or in the provider settings below. Never paste them into evidence, the tracker, commits or chat.

Hosted Supabase signs database certificates with its own root CA. Download it from Dashboard, Project Settings, Database, SSL Configuration (`prod-ca-2021.crt`); it is public, not a secret. `pg` treats `sslmode=require` as full verification, so every database connection needs that CA.

| Variable | Local file | Web project | Worker project | Value |
|---|---|---|---|---|
| `SCOPEROOM_DB_TARGET` | `.env.hosted.local` | | | `hosted` |
| `SCOPEROOM_SUPABASE_PROJECT_REF` | `.env.hosted.local` | | | the 20-letter project ref |
| `SCOPEROOM_ENVIRONMENT_ID` | `.env.hosted.local` | yes | yes | a fresh UUID for this target, never a local value |
| `SCOPEROOM_BOOTSTRAP_DATABASE_URL` | `.env.hosted.local` | | | session pooler (IPv4, port 5432), user `postgres.<ref>`, `?sslmode=require&sslrootcert=<absolute path to the CA>` |
| `MIGRATION_DATABASE_URL` | `.env.hosted.local` | | | same host, port, `sslmode` and `sslrootcert` as the bootstrap URL plus `schema=app` (Prisma keeps its history in `app`), user `app_migrator_runtime.<ref>`; no other query parameters |
| `SCOPEROOM_MIGRATOR_PASSWORD`, `SCOPEROOM_WEB_RUNTIME_PASSWORD`, `SCOPEROOM_WORKER_RUNTIME_PASSWORD` | `.env.hosted.local` | | | fresh random values; bootstrap provisions the login roles with them |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `.env.hosted.local` | yes | | `https://<ref>.supabase.co` and its publishable key |
| `APP_ENV`, `NEXT_PUBLIC_APP_URL` | | yes | | `production` and the bare HTTPS production origin |
| `DATABASE_URL` | | yes | | transaction pooler (port 6543), user `app_web_runtime.<ref>` |
| `WORKER_DATABASE_URL` | | | yes | transaction pooler (port 6543), user `app_worker_runtime.<ref>` |
| `SCOPEROOM_DATABASE_CA_PEM` | | yes | yes | the CA file's PEM text; runtime connections then verify the server whatever TLS parameters the URL carries |
| `SCOPEROOM_REALTIME_SIGNING_ALG`, `_KEY`, `_KID` | | yes | | `ES256`, the imported key's PKCS8 PEM and its key id ([Realtime setup](realtime-setup.md)) |
| `AI_MODEL` | | yes | | the bare model id (no spaces, line breaks or quotes); removing it pauses AI admission |
| `AI_TOTAL_RUN_LIMIT`, `AI_DAILY_RUN_LIMIT` | | optional | | default-plan AI limits for every account; blank keeps 5 total and 30 per day |
| `AI_EXECUTION_BINDING` | | yes | yes | the release SHA, the same on both projects, set before deploying (section 4) |
| `INNGEST_EVENT_KEY` | | yes | yes | the Inngest Production event key; added to the web project by hand, synced to the worker by the integration |
| `INNGEST_SIGNING_KEY` | | | yes | the Inngest Production signing key, synced by the integration; never on the web project |
| `SCOPEROOM_SERVICE` | | | yes | `worker` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | | | yes | the Gemini key; never on the web project |
| `SMOKE_URL`, `SMOKE_{OWNER,EDITOR,VIEWER}_{EMAIL,PASSWORD}`, `SMOKE_AI` | `.env.smoke.local` | | | production origin, three synthetic accounts, `1` only when an AI budget is authorized |

Never set bootstrap or migrator credentials on a Vercel project. The web project never holds `WORKER_DATABASE_URL`, `GOOGLE_GENERATIVE_AI_API_KEY` or `INNGEST_SIGNING_KEY`. The worker project holds only the variables marked above (plus Vercel system variables). `INNGEST_DEV` is never set on either project.

Vercel settings that cost a release during the first cutover:

- Each project's Function Region must be the region closest to the Supabase database. From a distant region the AI admission transaction (about 25 sequential queries) exceeded Prisma's 5 second interactive-transaction timeout and surfaced as 503 `UNAVAILABLE`.
- `AI_MODEL` must be the bare model id. Admission rejects anything else (spaces, line breaks, quotes) with 503.
- `AI_EXECUTION_BINDING` must be a Production environment variable on both projects. `vercel deploy -e` did not reach the runtime with CLI 48.
- Sign up for Inngest through the Vercel Marketplace and grant the Inngest integration access to the worker project ONLY. Add `INNGEST_EVENT_KEY` to the web project by hand; the web project never gets `INNGEST_SIGNING_KEY`. After granting, check that the worker project holds nothing beyond the worker column's variables and that the web project has no `INNGEST_SIGNING_KEY`.
- Keep Vercel Standard Deployment Protection on the worker project so old per-deployment URLs cannot be re-synced by anyone calling `PUT /api/inngest`. If the integration's sync needs it, use Vercel's Protection Bypass for Automation (verify at cutover).
- Keep the Vercel Supabase (and any database) integration disconnected from both projects: it re-adds privileged `POSTGRES_*` and `SUPABASE_*` variables.
- Vercel accepts multi-line values, so paste the CA PEM and the ES256 signing key with their line breaks.

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
2. Set `AI_EXECUTION_BINDING` to the SHA as a Production variable on both Vercel projects (section 2).
3. Migrate (section 3).
4. Deploy the worker from a clean detached worktree at the SHA. `vercel.json` turns off Git deployments, so the CLI is the only path:

   ```powershell
   git worktree add --detach ..\scoperoom-release <sha>
   cd ..\scoperoom-release
   vercel link --yes --project <worker project>
   vercel deploy --prod --yes
   ```

5. The Inngest integration syncs the functions on each worker deploy. Confirm the Inngest dashboard shows both functions (`run-ai`, `repair-runs`) on the current deployment and in the Production environment, not a branch environment (the SDK may derive a branch name from the git ref on CLI deploys; verify at cutover). If the sync did not happen, use the fallback:

   ```powershell
   curl -X PUT https://<worker origin>/api/inngest
   ```

6. Deploy the web project: relink the same worktree (`vercel link --yes --project <web project>`), then `vercel deploy --prod --yes`. Do not repeat `git worktree add`.
7. `GET <origin>/api/health` on the web origin returns `{"status":"ok","service":"scoperoom-ai","apiVersion":"v1"}`. The worker origin returns 404 for `/`, `/api/health`, `/api/projects` and image-suffixed paths, and the web origin returns 404 for `/api/inngest`. The web logger writes only failed requests, so `releaseId` cannot be read from healthy traffic; identify a release by its deployment ID.
8. A `repair-runs` run completes within about a minute in the Inngest dashboard.
9. `corepack pnpm test:smoke:hosted`, then record the deployment IDs and results in the tracker.

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

- Pause AI: remove `AI_MODEL` from the web project's Production variables and redeploy the same SHA. Admission then answers `UNAVAILABLE`; editing stays available. Pausing `run-ai` in the Inngest dashboard also pauses delivery: only never-claimed runs are refunded at their SQL deadline; a claimed call stays consumed.
- Pause everything: pause the Vercel web project.
- Then fix forward with a new SHA through the full release.

Later releases may use `vercel rollback` only to an earlier deployment whose schema and worker binding are still compatible.

## 7. Incidents

| Incident | Action on this target | Check |
|---|---|---|
| Credential or access exposure | Rotate the key in its provider, redeploy what reads it, run the smoke | Supabase API keys and database password, Vercel and Inngest settings, both Vercel projects |
| Bad web or worker release | Pause AI or the project (section 6), correct forward | Vercel deployments for both projects |
| Database unavailable or locked | Saves fail clearly; inspect pool and locks, reconcile through receipts | Supabase database reports and logs |
| Realtime unavailable or quota pause | Expect "Live updates delayed"; saves and status polling continue | Supabase Realtime reports |
| Worker or model outage | Runs show queued or failed with bounded attempts; manual work continues | The worker project's logs, the Inngest run list, Gemini quota |
| Auth or SMTP failure | Protected operations fail while verification is unavailable; retest with an operator mailbox | Supabase Auth logs, Resend |
| Bad migration | Stop releases; inspect Prisma state, prefer a corrective forward migration | `app._prisma_migrations` |

## 8. Known limitations

- Single target: no separate qualification environment; the first qualification ran on the production URL before it was shared. An unshared URL is not access control.
- Native provider logs only; retention below the 30-day policy; no alerting beyond provider defaults.
- No app request-rate limiter for commands and invitations; Supabase Auth email limits, the account plan and the import and AI limits apply.
- Rollback has no predecessor for the first release; abort is disable plus correct forward.
- Backups are as recorded in the tracker; no restore has been performed.
- `app_migrator` and `app_realtime_reader` inherit `anon` privileges on hosted (Supabase gives `postgres` no other way to grant `auth` access).
- Inngest orchestration runs in the US; our code and its database queries run in the region closest to the database. Each run pays that round trip.
- The Inngest free plan allows 100k executions a month via the Vercel Marketplace signup; repair uses about 43k.
- A worker with a different `AI_EXECUTION_BINDING` than a run (a run admitted before a release) fails that run's function without retry; the run times out with a refund.
