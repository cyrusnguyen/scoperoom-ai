# Testing ScopeRoom

Use the pinned Node and pnpm versions in package.json. Install with `corepack pnpm install --frozen-lockfile`, then generate the Prisma client with `corepack pnpm db:generate`.

## Choose the smallest useful check while editing

- Pure contracts/domain/outbox logic: affected unit files (`node --experimental-strip-types --test tests/<file>.test.ts`).
- Transaction, authorization or persisted version behavior: affected database integration files against the guarded local stack.
- Browser interaction, focus, hit areas, navigation or recovery UI: affected Playwright specs.
- Before merging a stable code change: required CI gates, including the complete browser suite.

Keep fast unit tests for edge-case combinations, database integration tests for authority/atomicity/retry guarantees, and browser tests for workflows and actual interaction. A real pointer regression is necessary for clipped connection handles; a pure direction calculation cannot replace it. Preserve dedicated authentication/session/membership coverage.

## Private Realtime socket suite

`corepack pnpm test:realtime` runs `tests/realtime/*.test.ts` serially against a guarded local Supabase stack. It signs fixture-created verified Auth users in with the publishable key and opens actual Realtime sockets; it never forges a JWT or uses the service secret as a socket credential. Prerequisites: the running stack, `db:bootstrap` or `db:migrate` (which installs the policies and the private-only tenant), and `.env.local` or CI variables for `E2E_SUPABASE_URL`, `E2E_SUPABASE_SECRET_KEY` (fixture accounts only), `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and the database/identity settings used by integration tests. Missing settings and an unverified tenant fail the run; nothing skips.

Before any socket opens, the suite runs `scripts/db/realtime.mjs verify`. The local Realtime container re-seeds its tenant as public on every container start, so after a restart run `corepack pnpm db:migrate` again. Negative delivery checks use a bounded observation window, are paired with the application's `getProjectStatus` result and the `app_private.can_realtime` decision, and always run beside a positive delivery on the same channel so an outage cannot pass as denial. Run this suite alone on its stack (CI runs it after `test:integration`, never in parallel with other users of that database).

## Stage 04.2 collaboration browser specs

All are `tests/e2e/collaboration-*.spec.ts` and run in the normal production suite.

- `collaboration-sync.spec.ts` (with `collaboration-fixtures.ts`): two real users, no mocked collaborator. The fixture provisions a disposable owner and an admitted EDITOR through the project and invitation APIs (auth state in memory, separate contexts), exposes `{ ownerPage, editorPage, projectId, setEditorRole, removeEditor }`, and closes both contexts before deleting receipts, projects and accounts. It is per test, never the worker account, because tests downgrade and remove the editor. The editor page freezes its clock and pins jitter to the minimum; `poll` advances it in 250 ms slices until a status read starts, bounded by `statusDelay`'s maximum (11 s), so a dirty edit's 10 s autosave cannot fire first and no fixed sleep decides convergence. Route interception only orders responses (held `D` reads, held or failed status reads). Status-delay ordering has no dedicated two-user browser test; it is covered by the unit tests `plan: draft counters read D; ... a shell already ahead do nothing` (`tests/collaboration-sync.test.ts`) and `one admission predicate: ... cover the floor` (`tests/project-ui.test.ts`), while the delayed-`D` ordering is a two-user test. A paused clock stalls the Next router, so the project-switch case resumes it.
- `collaboration-polling.spec.ts` (one timer per window across panel, view and project switches; a transient background bootstrap failure keeps the Studio mounted), `collaboration-notices.spec.ts` (frozen, redo-cleared, inspector, refreshing, floor), `collaboration-writes.spec.ts` (write-barrier races, real 100+1 split, 403/404/503, account change, blur), `collaboration-details.spec.ts` (Details guards; Details and Share writes wait for the status barrier) and `collaboration-auth-outage.spec.ts` use one account with a manufactured "someone else" (or mocked status).
- Auth outage: Supabase's URL is compiled into the build, so `collaboration-auth-outage.spec.ts` starts a second `next start` of the same build on port + 50 with `NODE_OPTIONS=--import tests/support/auth-fault.mjs`. The preloaded fetch wrapper fails only that process's Auth calls, switched by a mode file (`AUTH_FAULT_FILE`). It runs only under `test:e2e:production`; the shared stack never stops.
- Gates: `corepack pnpm lint`, `typecheck`, `test:unit`, `test:integration`, `test:realtime` (alone on its stack), `build`, then `PLAYWRIGHT_PORT=3105 PLAYWRIGHT_WORKERS=2 corepack pnpm test:e2e:production`. `access.spec.ts` hard-codes a local-port allowlist that excludes the guarded stack's 59321; run it separately with a temporary uncommitted allowlist edit and revert it.

## Browser fixture ownership

The ten Studio specs import their test fixture from `tests/e2e/studio-fixtures.ts`. Each worker owns a unique entitled test account and keeps its authentication state in memory. Playwright supplies a fresh browser context for each test. The fixture closes the context and allows outstanding requests to settle before deleting every project owned by that account and its mutation receipts. Worker teardown deletes the account. The normal ten-project allowance is retained.

Authentication, session-refresh and membership specs keep their dedicated accounts. Do not migrate a test that invalidates its server session or changes account-wide authority without revisiting fixture ownership.

`seedStudioChanges` prepares prerequisite graphs through the real batch API using proposed ids and sequential revision guards. Actual UI creation, handle gestures, unsaved outbox edits, focus, undo, autosave and conflict/retry assertions remain in the browser. Fixture-only dialog steps can be replaced with API setup; scenario behavior cannot.

This follows [Playwright's worker-account pattern](https://playwright.dev/docs/auth#moderate-one-account-per-parallel-worker), with separate project cleanup for ScopeRoom's account quota.

## Browser runner

The existing `corepack pnpm test:e2e:chromium` command remains useful for focused development runs. On Windows it expects a separately started test server. Use `SCOPEROOM_E2E=1` and the matching `NEXT_PUBLIC_APP_URL` when starting that server; the normal developer app remains on port 3100.

`corepack pnpm test:e2e:production` builds the isolated `.next-e2e` output, runs Chromium against a managed production server and records both build and test time. Production runs default to two workers; development/external-server runs retain one. Override either with `PLAYWRIGHT_WORKERS=1` or `2`. Files run in parallel; tests inside each file remain sequential. Local settings are read from ignored `.env.local`. CI provides its own isolated database/Auth settings.

PowerShell example for this optimization worktree:

```powershell
$env:PLAYWRIGHT_PORT = '3102'
$env:PLAYWRIGHT_WORKERS = '2'
corepack pnpm test:e2e:production tests/e2e/studio-canvas.spec.ts tests/e2e/studio-outbox.spec.ts
```

- `test-results/playwright-results.json`: per-test status, duration and failure details from Playwright's built-in JSON reporter.
- `test-results/e2e-timing.json`: production build duration, test phase duration, total duration and exit codes.
- Failure traces remain under `test-results/`. CI retains timing reports even when a run succeeds.

Treat these reports as test artifacts: keep them out of Git. Authentication state must stay in memory or ignored local files, never in published reports.

## Performance methodology

Compare the same test names and assertions. Record worker count, serving mode, build cost, skips, failures and retries. A faster run with failures or lost coverage is not an improvement. Use a representative subset while iterating and one complete run on the final configuration. Avoid simultaneous benchmark runs, which compete for browser, CPU and database resources.

The untouched Stage 03.3 baseline for this worktree is commit `913585b`: 162 unit tests, 75 integration tests and 161 Chromium tests. Local baseline canvas plus outbox: 14 passed, 0 skipped/failed, 237.277 seconds using a fresh development server and one worker. The recorded prior complete Chromium run was 19.3 minutes; it is historical context, not a controlled comparison to the new configuration.


## Measured optimization

Matched canvas/outbox corpus, 14 unchanged scenario names and behavior assertions, on the same Windows machine and local Supabase stack:

| Configuration | Build | Test phase | Total observed | Outcome |
| --- | ---: | ---: | ---: | --- |
| Original fixtures, fresh next dev, one worker | Compiled on demand | 237.277 s | 237.277 s | 14 passed |
| Optimized fixtures, next start, one worker | 9.478 s | 36.774 s | 46.252 s | 14 passed |
| Optimized fixtures, next start, two workers | 10.891 s | 29.045 s | 39.937 s | 14 passed |

All matched runs had zero skips, failures and retries. The optimized production totals include an explicit build, using the local build cache populated during runner verification. The original baseline includes on-demand development compilation and excludes the separately started dev process's startup. These measurements demonstrate the combined serving/fixture change; they do not isolate the benefit of account reuse alone or predict cold Linux CI runtime.

The first production attempt passed its assertions but hung at Windows server teardown because the execution environment omitted System32 from PATH. It is excluded from these timings. The production wrapper supplies the Windows system executable path for its child processes, allowing Playwright to terminate its own managed server.

Final verification on merged main `cc7ad2b` (2026-09-30): **162/162 unit**, **75/75 integration**, and **161/161 Chromium** passed with zero skips or failures. The browser run also had zero flaky results and preserved every baseline scenario name. Lint, typecheck and Prisma validation passed. The production runner used its default two workers: build **41.739 seconds**, test phase **289.174 seconds**, total **330.913 seconds (5 min 31 s)**. The managed server released port 3102 and the local database had zero remaining Studio worker accounts. Independent task, final and rebase reviews found no issues. The PR workflow reports Linux CI separately; local timings do not predict cold CI performance.
