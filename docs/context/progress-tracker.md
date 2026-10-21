# Progress tracker

Observed state and the next action. Dated entries up to 2026-10-21, with their evidence, are in [progress history](progress-history.md).

## Current state (2026-10-21)

- Production: release run 39185379268 deployed main `87ea6a6` (PR #50), after run 38995610226 deployed `061ddec` (PR #49); both succeeded.
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

- `fix/security-review` (PR #51) from main `87ea6a6`, requested by the user: a whole-project security review, an AI slop cleanup, and why the Supabase publishable key shows in the browser network tab. Four read-only sweeps (web, auth and routes; database, worker, AI and CI; two for slop), then an independent review of the diff.
  - Security review: no critical, high or medium finding. Every API route goes through a wrapper with verified identity, exact-origin writes and bounded bodies; child ids are always filtered by project; no raw unsafe SQL; definer functions pin `search_path`; AI output is validated before storage and again at Apply; CI uses `pull_request` with pinned actions. Proxy path variants (`/api/%69nngest`, `/API/inngest`, `/api/./inngest`) all answer 404 on a local web-mode server.
  - Publishable key: it is the `apikey` on the Realtime socket (`src/client/realtime.ts`), public by Supabase's design; authority is the server-minted 5-minute scoped credential plus the policies on `realtime.messages`. With only that key on the local stack, the Data API lists no table, view or function, GraphQL is off, there are no Storage buckets, public channels are refused (`PrivateOnly`) and private topics are refused. A direct hosted probe was not permitted in this session; release run 39185379268 proved private-only Realtime on hosted.
  - Hardening: `nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` on every response. The release edge checks now `POST {}` to the worker's `/api/inngest` and expect 401, so a worker that stopped verifying Inngest signatures (`INNGEST_DEV`, answers 500) fails the release; a bodyless POST answers 401 in every mode, so the body matters. `realtime.mjs verify` (every `db:migrate`) now fails when anon or authenticated can reach a table, view or non-trigger function in `public`, which the Data API would serve to any holder of the key.
  - Slop: one body reader instead of two in `api-request.ts` (the JSON content type is now matched exactly, as uploads already were); one signed-in check for the five signed-out pages and one unavailable card; dead code (`runMaintenance`, unused logger levels, a re-export, an unused parameter, an unused env placeholder); duplicated regexes, byte counters, id generators, cookie options and limits replaced by the existing ones; plan task numbers and stale comments rewritten; five minified review routes reformatted; the AI probe now supports Anthropic models.
  - Evidence (local stack `scoperoom-stage04-test`): `lint` and `typecheck` pass; unit 752/752; integration 414/414; workers 35/35; Realtime 14/14; the full production browser suite 506/506 (0 flaky, 0 skipped, two workers), and after four later complexity cuts the review and AI specs 106/106 on a fresh build; the new Realtime test fails when the check is removed, and the new release test fails on the shadowed variable an earlier draft had. Nothing was checked against the hosted target or a live model.

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
- Turn off the hosted Data API in the Supabase settings (the user will): the app never uses PostgREST or GraphQL. The browser's publishable key then reaches only Auth, Realtime and Storage, which is a separate service with no buckets and RLS on without policies.
- Content Security Policy: only `frame-ancestors`, `object-src` and `base-uri` are set; a nonce-based `script-src` is not.
- Stage 12b remainder: log search and pg_cron health in the dashboards, the Auth email limit and the backup plan.
- Decisions not yet made: inviting users (needs a second authorization) and the source budget (per-actor quotas, purge or owner override).
- Deferred: Stage 08 (scenarios, readiness, coverage), Stages 10 and 11, and 07c (questions, answers, decisions, activity); Stage 09's uncertain Start recovery after a draft replacement.
- Manual NVDA screen reader pass, including the AI conversation thread.
- `collaboration-auth-outage.spec.ts` once had a status-read race that was never proven gone.

## Next

1. Review and merge PR #51 (`fix/security-review`), then release it. It has no migration. Its new `realtime.mjs verify` check first runs against hosted in that release's database step.
