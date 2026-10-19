# Progress tracker

Observed state and the next action. Dated entries up to 2026-10-16, with their evidence, are in [progress history](progress-history.md).

## Current state (2026-10-19)

- Production: release run 38995610226 deployed main `061ddec` (PR #49), after run 38917577133 deployed `6fba4fd` (PR #48); both succeeded.
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

- `fix/audit-findings` from main `061ddec`, requested by the user: fixes from a whole-codebase audit for concurrency, performance, N+1 queries, missing awaits, logic errors and dirty code. A type-aware lint found no floating or misused promises. Each change had an independent review; the findings were fixed and re-reviewed. Changes:
  - The citation excerpt re-rendered the whole shell for ever when the cited lines were blank; the shared `setDraft` now returns the same store for an unchanged value.
  - Every write that takes the project or owner capacity lock now has the 15 s transaction budget saves already had, set once as the database client's default (`transactionOptions` in `src/server/db.ts`; read snapshots keep 5 s); Prisma counted the lock wait against 5 s, so commands, positions, reviews, imports, member and invitation writes answered 503 under contention. The timer runs only between the function and the database, so a distant browser does not shorten it.
  - Import quotas: applied previews keep their body 7 days but no longer count as open previews (10 per actor), so 10 imports a week no longer block every preview; the byte caps still count them. Cleanup deletes discarded and expired preview rows 30 days after expiry (`deletedPreviews`, migration `20261019000000`), so the row cap no longer fills for ever.
  - AI: admission refuses a capture over the 16,000 input-token estimate before it keeps prompt evidence, a slot or budget; the panel limits the instruction to 8,000 normalized code points and says what to change. Deleting a run refunds every unclaimed reservation; a crashed attempt followed by revoked access ends ACCESS_REVOKED when its window closes instead of holding the slot until the deadline; a second call that times out is `MODEL_TIMEOUT` (migration `20261019000100`). The always-unknown dispatcher `cancel` is gone, and a read-only role no longer leaves a stuck pending request.
  - Performance: canvas steps, edges and handlers keep their identity, so a drag frame or typing in another panel no longer re-renders every step; arrow keys on a selected step are stopped before React Flow shifts its own copy. Moves-only and sides-only saves no longer send and rewrite the whole document. `/api/me` reads the staff role once; applying a proposal inserts its sources in one statement.
  - Writes give up after 120 s as uncertain (same-key retry), so a dead connection cannot hold a save. Two shell writes now end the session on 401, review history Load more no longer drops a refresh in flight, the lost-link invitation button says what it does, and an unused source-list helper is gone.
  - Evidence (local, guarded stack `scoperoom-stage04-test`, recreated with its published ports pinned to 127.0.0.1 after `supabase start`): `lint` and `typecheck` pass; unit 751/751; integration 414/414; workers 35/35; Realtime 13/13; the full production browser suite 504/504 (0 flaky, 0 skipped, two workers) at `6b9c975`. Each new test fails without its fix. No change was checked against the hosted target or a live model.

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
- Dependencies: `pnpm audit` lists 5 findings (4 high, 1 moderate), all in build or dev tooling.
- Local stack on Windows: Docker Desktop publishes Supabase ports on all interfaces, so `scripts/db/guard.mjs` refuses it until the published containers are recreated with ports on 127.0.0.1.
- Exchange: an applied import stays a permanent identity, so 1,000 applied imports per actor and 2,000 per project remain lifetime row caps.

## Open follow-ups

- Paste `supabase/templates/confirmation.html` into Supabase Auth (Confirm signup) with the subject `Confirm your ScopeRoom email`, then check one sign-up.
- Delete the old Trigger.dev project and revoke its token.
- Stage 12b remainder: log search and pg_cron health in the dashboards, the Auth email limit and the backup plan.
- Decisions not yet made: inviting users (needs a second authorization) and the source budget (per-actor quotas, purge or owner override).
- Deferred: Stage 08 (scenarios, readiness, coverage), Stages 10 and 11, and 07c (questions, answers, decisions, activity); Stage 09's uncertain Start recovery after a draft replacement.
- Manual NVDA screen reader pass, including the AI conversation thread.
- `collaboration-auth-outage.spec.ts` once had a status-read race that was never proven gone.

## Next

1. Open the `fix/audit-findings` PR once the user approves, then CI, review and release. Its two migrations run before the worker deploy; the old worker and web code work with both.
