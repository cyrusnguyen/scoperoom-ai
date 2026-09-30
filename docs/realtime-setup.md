# Private Realtime setup

Stage 04.1 makes Supabase Realtime private-only. The database decides who may join, read and send; the browser's `private: true` flag is not enforcement.

## Topics and capabilities

Topics are exactly `project:<projectId>:<realtimeEpoch>:events` and `...:collab`, built from database UUID text (lower-case). `app_private.can_realtime(topic, capability)` derives identity only from `auth.uid()` and the current database membership, compares exact text and returns a boolean.

| Topic | Broadcast receive | Broadcast send | Presence |
|---|---|---|---|
| `events` | project members | nobody (browsers never send) | nobody |
| `collab` | project members | ACTIVE-project owner or editor | project members |

Archived projects stay readable; deleting projects, removed members, anonymous users and strangers are denied. Supabase caches channel permissions, so removal is not instant eviction; the epoch rotation and the application's own authorization govern refetch.

## What `scripts/db/realtime.mjs` does

It runs only against the guarded local target (loopback database container plus environment identity) and is wired into `db:bootstrap` and `db:migrate`:

- `prepare` (before Prisma deploy): creates the NOLOGIN roles `app_realtime_reader` (helper owner) and `app_realtime_notifier` (reserved for the Stage 04.1 database notifier) and the `app_private` schema owned by `app_migrator`.
- `apply` (after deploy): grants the reader only column `SELECT` on the joined columns, transfers the helper to the reader, verifies owner, search path and effective privileges, then grants `authenticated` schema `USAGE` and helper `EXECUTE` and replaces the two named policies `scoperoom_rt_select` and `scoperoom_rt_insert` on `realtime.messages` in one transaction. It refuses to continue when another permissive policy grants `authenticated`, `anon` or PUBLIC access to `realtime.messages`. It does not enable RLS, change provider ownership or recreate `realtime.send`.
- `verify`: read-only re-check of roles, function, privileges, policies, provider RLS and the private-only tenant flag. Setup does not report success without it.

Applying twice yields identical policy definitions and no second Prisma migration. Future migrations that replace `app_private.can_realtime` must be run by the guarded deployment process with `app_realtime_reader` granted to `app_migrator` for that run only and revoked in `finally`; never grant it to runtime or browser roles.

## Private-only tenant (local)

Installed image `supabase/realtime:v2.130.0` exposes the tenant API on port 4000 inside its container (not published). The script signs a short-lived management JWT with the container's `API_JWT_SECRET` in memory, calls `GET /api/tenants/realtime-dev` (must exist), then `PUT /api/tenants/realtime-dev` with `{"tenant":{"private_only":true}}` when needed, and reads the flag back. The call runs through `docker exec ... curl` against the container verified by label and loopback network. Bodies contain encrypted provider settings and are never printed. The local Realtime container re-seeds its tenant with `private_only = false` on **every container start** (not only on a fresh stack), so after any Realtime container restart or `supabase start` rerun `corepack pnpm db:migrate` (or `db:bootstrap`) to set the flag again. `test:realtime` runs `realtime.mjs verify` before opening a socket and fails when the tenant is public, so a restarted container cannot masquerade as a pass.

Verified on v2.130.0: a socket subscribing with `config.private = false` is refused with `PrivateOnly: This project only allows private channels`, and an unauthorized private join (stranger, removed member, malformed or stale-epoch topic, DELETING project, anonymous browser) is refused with `Unauthorized: You do not have permissions to read from this Channel topic`. A denied Broadcast or Presence write is not an error: the send is simply not acknowledged (client status `timed out`) and nothing is delivered, which is why negative socket tests pair a bounded silence window with a positive control and the SQL decision.

Presence: the local tenant has `presence_enabled = false` and Presence track/join/sync nevertheless work over private channels (reviewer and viewer included) on v2.130.0, so the flag is left alone. Presence callbacks must be registered before `subscribe()`.

## Hosted equivalent

In the Supabase Dashboard, Realtime settings, turn "Allow public access" off. No hosted change is made by this repository's automation; apply the same helper migration, `apply` policies and this setting during the hosted rollout under its own approval.
