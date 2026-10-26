# Progress tracker

Observed state and the next action. Dated entries up to 2026-10-26, with their evidence, are in [progress history](progress-history.md).

## Current state (2026-10-26)

- Production: release run 39607868235 deployed main `129ca58` (PR #51), after run 39185379268 deployed `87ea6a6` (PR #50); both succeeded.
- Studio: canvas and List views, Add step, Connect, Arrange, inline label editing and a shape panel. The open flow's scope badge sits beside the flow switcher in the header (PR #46).
- Panels: docked Projects sidebar (220 to 480 px) and right panel (320 to 720 px) resize by pointer or keyboard, keeping the editor at least 560 px wide (PR #31).
- Collaboration: Owner, Editor, Reviewer and Viewer roles; presence, live cursors and drag previews over Realtime; removing access stops backend access and new joins at once.
- Exchange: native JSON import (previewed, creates an unapproved copy) and export.
- AI: Generate and Improve with durable run history, captured context, Apply all or a chosen subset, and follow-up answers after a clarification (PR #44). Production uses `anthropic/claude-sonnet-5-5`; the worker is a separate Vercel project in the database's region, with Inngest running only `run-ai`.
- AI budget: default plan of 10 active owned projects, 5 AI requests in total and 30 a day, charged to the project owner; the AI panel shows what is left; per-account overrides.
- Specs: immutable text sources (paste, `.txt` or `.md` upload, saved-flow extract) with versions; requirements with inclusion, owner, verification and line citations, plus requirement-to-step trace links (PRs #27, #28).
- Review: confirmation, candidate checks, immutable freeze, designated approvals, publication that keeps newer draft work, approved history and approved-only Markdown (PRs #29, #30).
- Access: any verified account creates projects; email-code password recovery; Admin and Moderator staff roles with an accounts screen (PR #42).
- Release: green push CI on main queues a release that waits for approval in the protected `release` environment; a manual run can pick a commit and add the paid AI smoke.

## In progress

- `fix/dependency-cves` (PR #52) from main `129ca58`, requested by the user: scan for the new Next.js CVEs and other security issues.
  - Upgrades: Next.js and `eslint-config-next` 16.3.8 to 16.4.3; Prisma 7.10.0 to 7.10.1 (`deepmerge-ts` stack exhaustion); lockfile-only updates to `undici` 7.30.1, `body-parser` 2.4.0, `fast-uri` 3.1.9, `mysql2` 3.24.4, `source-map-js` 1.2.2 and `zod` 4.6.7. `pnpm audit` went from 16 findings (2 critical, 7 high, 5 moderate, 2 low) to none.
  - Next.js exposure: the Server Action CPU denial of service (GHSA-p3m5-59mp-jv5r) applied, since sign-in and recovery use Server Actions. The `use cache` RCE (GHSA-673q-mjm6-r5xr) did not: no `use cache` function. The image optimizer RCE (GHSA-2464-fhr4-w9xw) did not either: no `next/image` and `sharp` was already 0.35.5.
  - A fresh read-only code security review found no critical, high or medium issue; its low items (no app-level sign-in throttle, CSP without `script-src`) are already recorded below.
  - Evidence (local guarded stack `scoperoom-stage04-test`): `lint`, `typecheck` and build pass; unit 752/752; integration 414/414; workers 35/35; Realtime 14/14 (`token-boundary.test.ts` hung once on the week-old local Realtime container and passed 3/3 on rerun); the full production browser suite 506/506 (0 flaky, 0 skipped). Nothing was checked against the hosted target or a live model.

## Accepted limitations

- Realtime: a removed member's already-joined socket keeps its topic until the credential expires.
- Worker: Inngest orchestration runs in the US on the free plan (50K executions a month, AI runs only); the web project blocks the worker routes in the proxy only.
- Invitations send no email; the owner copies the link.
- Writes are accepted only from `NEXT_PUBLIC_APP_URL`, so a per-deployment preview URL cannot be smoke-tested.
- No request-rate limiter (user decision); staff reads are paged but not rate limited.
- Staff: operator SQL does not advance the entitlement version; staff screens show display names and short ids, not email addresses.
- Sources: an editor can fill the shared source budget, which blocks new source versions and AI admission; removing that editor does not free it.
- AI: Anthropic 402 and 413 count as `unknown` (one extra unbilled claim); a long follow-up thread plus a large graph can exceed the 16,000 input-token budget.
- AI: Claude gets the result schema only as text, so other format slips are still possible; `SHAPE` does not name the field or rule, and a refused result closes the run without a second call.
- Studio: below 640 px, keyboard focus reaches the flow switcher row before Save, Inspect and AI.
- Local stack on Windows: Docker Desktop publishes Supabase ports on all interfaces, so `scripts/db/guard.mjs` refuses it until the published containers are recreated with ports on 127.0.0.1.
- Exchange: an applied import stays a permanent identity, so 1,000 applied imports per actor and 2,000 per project remain lifetime row caps.

## Open follow-ups

- Paste `supabase/templates/confirmation.html` into Supabase Auth (Confirm signup) with the subject `Confirm your ScopeRoom email`, then check one sign-up.
- Delete the old Trigger.dev project and revoke its token.
- Turn off the hosted Data API in the Supabase settings (the user will): the app never uses PostgREST or GraphQL. The browser's publishable key then reaches only Auth, Realtime and Storage, which is a separate service with no buckets and RLS on without policies.
- Content Security Policy: only `frame-ancestors`, `object-src` and `base-uri` are set; a nonce-based `script-src` is not.
- Stage 12b remainder: log search and pg_cron health in the dashboards, the Auth email limit and the backup plan.
- Decisions not yet made: inviting users (needs a second authorization) and the source budget (per-actor quotas, purge or owner override).
- Deferred: Stage 08 (scenarios, readiness, coverage), Stages 10 and 11, and 07c (questions, answers, decisions, activity); Stage 09's uncertain Start recovery after a draft replacement.
- Manual NVDA screen reader pass, including the AI conversation thread.
- `collaboration-auth-outage.spec.ts` once had a status-read race that was never proven gone.

## Next

1. Review and merge PR #52 (`fix/dependency-cves`), then release it. It has no migration.
