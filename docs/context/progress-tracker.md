# Progress tracker

Observed state and the next action. Dated entries up to 2026-10-16, with their evidence, are in [progress history](progress-history.md).

## Current state (2026-10-16)

- Production: release run 38855897297 deployed main `77002e3` (PR #46). Migration, worker and web deploys, schedule, edge checks and the hosted smoke passed. The manual releases of #44 and #45 also ran the Claude AI smoke and passed.
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

- `fix/flaky-tests-and-ai-citations`, flaky tests: a code review of every suite (not repeat runs) found tests that typed before a frame-delayed focus move, acted before the page's Realtime join had read status, asserted cursors or autosave on a running clock, or seeded database deadlines only 0.5 to 3 s away. Each now waits for the state it depends on or has real slack on the database clock. It also found the worker account's daily AI budget filling up within one AI spec pass (now reset in cleanup) and AI admission running on Prisma's 5 s transaction default (now 15 s, like the other writes). Evidence: local run with every change, unit 744/744, integration 408/409 (the miss was the invitation contention test, whose rewrite then passed 3 of 3 on its own), workers 33/33, browser 503/503 once each with 0 flaky. The keyboard Studio flake from main CI run 38870458087 was reproduced locally by delaying the focus frame, and passes with the fix.
- Same branch, `RESULT_SHAPE`: Claude refused results as `RESULT_SHAPE` because it often leaves out the empty `citations` list when a run has no sources, and the validator required the key. Replaying the failed production capture 10 times gave 5 such refusals and nothing else wrong. A missing list now means no citations; a `null` or malformed one is still refused. Evidence: the new unit test fails on the old validator and passes now; the 5 refused real replies validate and diff as 14-operation proposals.

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
- Studio: the draft read has no client timeout, so a hung request leaves the flow dialog open. Below 640 px, keyboard focus reaches the flow switcher row before Save, Inspect and AI.
- Dependencies: `pnpm audit` lists 5 findings (4 high, 1 moderate), all in build or dev tooling.
- Local stack on Windows: Docker Desktop publishes Supabase ports on all interfaces, so `scripts/db/guard.mjs` refuses it until the published containers are recreated with ports on 127.0.0.1.

## Open follow-ups

- Paste `supabase/templates/confirmation.html` into Supabase Auth (Confirm signup) with the subject `Confirm your ScopeRoom email`, then check one sign-up.
- Delete the old Trigger.dev project and revoke its token.
- Stage 12b remainder: log search and pg_cron health in the dashboards, the Auth email limit and the backup plan.
- Decisions not yet made: inviting users (needs a second authorization) and the source budget (per-actor quotas, purge or owner override).
- Deferred: Stage 08 (scenarios, readiness, coverage), Stages 10 and 11, and 07c (questions, answers, decisions, activity); Stage 09's uncertain Start recovery after a draft replacement.
- Manual NVDA screen reader pass, including the AI conversation thread.
- `collaboration-auth-outage.spec.ts` once had a status-read race that was never proven gone.

## Next

1. Merge the missing-citations fix once its CI and review pass, release it, and check that new Claude runs without sources succeed.
