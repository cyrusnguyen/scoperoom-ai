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

- `prepare` (before Prisma deploy): creates the NOLOGIN roles `app_realtime_reader` (helper owner) and `app_realtime_notifier` (owner of the hint adapter and trigger function) and the `app_private` schema owned by `app_migrator`.
- `apply` (after deploy): grants the reader only column `SELECT` on the joined columns, transfers the helper to the reader and the two hint functions to the notifier (temporary owner membership and schema `CREATE`, revoked in the same transaction), verifies owner, search path and effective privileges, then grants `authenticated` schema `USAGE` and helper `EXECUTE` and replaces the three named policies `scoperoom_rt_select`, `scoperoom_rt_insert` and `scoperoom_rt_hint` on `realtime.messages` in one transaction. It refuses to continue when another permissive policy grants `authenticated`, `anon` or PUBLIC access to `realtime.messages`. It does not enable RLS, change provider ownership or recreate `realtime.send`.
- `verify`: read-only re-check of roles, function, privileges, policies, provider RLS and the private-only tenant flag. Setup does not report success without it.

Applying twice yields identical policy definitions and no second Prisma migration. Future migrations that replace `app_private.can_realtime` must be run by the guarded deployment process with `app_realtime_reader` granted to `app_migrator` for that run only and revoked in `finally`; never grant it to runtime or browser roles.

## Committed change hints

`AFTER UPDATE OF event_sequence ON app.project ... WHEN (NEW.event_sequence > OLD.event_sequence)` runs `app_private.notify_project_changed()`, which calls the adapter `app_private.enqueue_project_hint(payload, topic)`, which calls the installed `realtime.send(payload, 'PROJECT_CHANGED', topic, true)`. The hint is written in the same transaction as the save, so a rollback discards it and only committed saves are delivered. Every effective save advances the sequence in one project UPDATE (by the number of audit entries), so a batch yields one hint. No-op saves, receipt replays and refused saves do not touch the sequence and emit nothing; project creation sets the initial sequence in its INSERT and emits nothing (initial bootstrap is authoritative). The payload is `{type, projectId, epoch, eventSequence}` and the topic `project:<id>:<NEW.realtime_epoch>:events`, both from the row at that UPDATE. A management operation that rotates the epoch in the same transaction may therefore hint the old or the new namespace; clients that miss it recover by status polling (04.2 in the rewritten plans; browser subscriptions follow in 04.3).

- **Extra `id` key.** The provider's `realtime.send` adds its own random message `id` to every payload that lacks one, so the delivered JSON has those four fields plus `id` (a UUID with no project data). Clients must ignore `id`; the integration and socket tests assert the exact four-field set beside it.
- **Failure isolation.** The trigger guards only the enqueue: any exception raises `SCOPEROOM_REALTIME_ENQUEUE_FAILED project=... sequence=... sqlstate=...` and the save proceeds. The installed provider function (v2.130.0, owner `supabase_realtime_admin`, not SECURITY DEFINER) additionally catches its own insert errors and only raises its warning `WarnSendingBroadcastMessage`; no second application warning is added for that case. A raising adapter (fault injection in `tests/realtime/notifications.test.ts`) is covered by the guard.
- **Privileges.** The trigger function and adapter are SECURITY DEFINER, owned by `app_realtime_notifier`, with an empty search path and no `PUBLIC` or role `EXECUTE`; browsers, the web/worker/migrator runtimes and the reader cannot call them, so nobody can fabricate a hint. The notifier can use `app_private` and `realtime.send` and may insert into `realtime.messages` only through policy `scoperoom_rt_hint` (`broadcast`, private, event `PROJECT_CHANGED`, an `...:events` topic); it cannot read `app`, the helper or provider messages. The trigger fires for any role that updates `app.project`, including `app_web_runtime`.
- **Fault injection.** The serial suite replaces only the application-owned adapter through a transaction-scoped notifier membership and restores its exact definition, owner, ACL and search path in `finally`; it also adds a temporary audit-table constraint for one fixture project. Never run browsers or the integration suite against that stack during `test:realtime`.

## Private-only tenant (local)

Installed image `supabase/realtime:v2.130.0` exposes the tenant API on port 4000 inside its container (not published). The script signs a short-lived management JWT with the container's `API_JWT_SECRET` in memory, calls `GET /api/tenants/realtime-dev` (must exist), then `PUT /api/tenants/realtime-dev` with `{"tenant":{"private_only":true}}` when needed, and reads the flag back. The call runs through `docker exec ... curl` against the container verified by label and loopback network. Bodies contain encrypted provider settings and are never printed. The local Realtime container re-seeds its tenant with `private_only = false` on **every container start** (not only on a fresh stack), so after any Realtime container restart or `supabase start` rerun `corepack pnpm db:migrate` (or `db:bootstrap`) to set the flag again. `test:realtime` runs `realtime.mjs verify` before opening a socket and fails when the tenant is public, so a restarted container cannot masquerade as a pass.

Verified on v2.130.0: a socket subscribing with `config.private = false` is refused with `PrivateOnly: This project only allows private channels`, and an unauthorized private join (stranger, removed member, malformed or stale-epoch topic, DELETING project, anonymous browser) is refused with `Unauthorized: You do not have permissions to read from this Channel topic`. A denied Broadcast or Presence write is not an error: the send is simply not acknowledged (client status `timed out`) and nothing is delivered, which is why negative socket tests pair a bounded silence window with a positive control and the SQL decision.

Presence: the local tenant has `presence_enabled = false` and Presence track/join/sync nevertheless work over private channels (reviewer and viewer included) on v2.130.0, so the flag is left alone. Presence callbacks must be registered before `subscribe()`.

## Hosted equivalent

In the Supabase Dashboard, Realtime settings, turn "Allow public access" off. No hosted change is made by this repository's automation. The migration carries over, but `realtime.mjs apply` does not: it needs local `docker exec` access as `supabase_admin` for the provider grants and for the tenant API. Provisioning those grants on hosted is an open item for the hosted gate; on the local stack `postgres` has no grant option on `realtime.messages`, so the notifier's `INSERT` grant may need a different design there. `verify` also compares function bodies with the migration (md5 constants in `scripts/db/realtime.mjs`), so a deliberate body change updates those constants in the same change.
