# Admin Dashboard plan

Status: planned, not started. Implement after the hosted pilot stage (Stage 12) is complete. Decided by the user on 2026-10-12.

## Goal

Give platform administrators one screen to see every account's plan and usage and to change its limits, instead of writing SQL. Limits are customisable for any account, members as well as staff.

## Starting point (delivered with the default account plan)

- An account without a `pilot_entitlement` row is on the default plan in `src/features/projects/server/plan.ts`: 10 active owned projects, 5 AI requests in total and at most 30 a day.
- A row is an override. While active and unexpired it sets `max_owned_projects`, `ai_total_run_limit` and `ai_daily_run_limit`; NULL AI limits are unlimited. An inactive or revoked row blocks project ownership and AI. An expired row falls back to the default plan.
- AI usage is charged to the project owner and counted from `ai_budget_day` (consumed plus still reserved runs; refunded reservations leave no count).
- Until the dashboard exists, an operator changes an account with SQL on the migrator connection, for example `insert into app.pilot_entitlement (profile_id, granted_by_operator, ai_total_run_limit, ai_daily_run_limit) values ($1, $2, null, null) on conflict (profile_id) do update set ai_total_run_limit = null, ai_daily_run_limit = null, active = true, revoked_at = null` to make an account unlimited.

## Scope

1. Platform admin role
   - New `app.platform_admin` table (profile id, granted by, granted at, revoked at). Separate from project roles; a project Owner is not an admin.
   - The first admin is granted by an operator script; later admins are granted from the dashboard by an existing admin, never by self-service.
   - Every admin request rechecks the role server-side in the same transaction as the change.
2. Accounts list (`/admin/accounts`)
   - Search by email or display name; page by cursor.
   - Columns: name, email, plan (Default, Custom, Blocked), active owned projects of the limit, AI requests used of the total, AI requests today of the daily limit, last activity.
3. Account detail and limit editor
   - Edit max owned projects, AI total limit, AI daily limit (each with an Unlimited option where allowed), expiry, and block or unblock with a required reason.
   - "Reset to default plan" removes the override.
   - Writes go through one versioned, idempotent service with a receipt, like other mutations; the web role gets no direct UPDATE grant on `pilot_entitlement`, only a SECURITY DEFINER function that checks the admin role.
4. Audit
   - New `app.account_audit_event` table for account-level changes (actor, target account, before and after limits, reason, request id), because `audit_event` is project-scoped.
   - The account detail shows the change history.
5. Usage visibility for users
   - The AI tab shows the owner's remaining AI requests ("3 of 5 AI requests left") and the daily count when a limit applies, so default-plan users see the limit before a refusal.
   - The Projects sidebar keeps showing "N of M active" from the same plan.

## Out of scope

Billing, payment providers and paid plan purchase; self-service plan changes; bulk edits; per-project overrides; deleting accounts.

## Verification

- Unit: limit validation and plan resolution, including expiry and blocked states.
- Integration: only admins can read or write; concurrent limit edits use version checks; lowering a limit below current usage refuses new projects and AI requests without touching existing projects or runs; every change writes one audit row.
- Browser: an admin edits limits and a normal account cannot reach `/admin`; keyboard and 320 px checks for the list and editor.
- Security review of the admin authority path and grants before release.
