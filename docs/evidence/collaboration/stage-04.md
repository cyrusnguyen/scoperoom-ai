# Stage 04.3 evidence: browser presence, live previews and recovery

Local evidence only. Hosted Supabase was never touched; hosted release evidence is listed separately at the end and is NOT RUN.

## Branch, SHAs and environment

- Branch `feat/stage-4.3-browser-presence-realtime`, based on the 04.2 head `50b3a02`. Task commits `649bfea..1a9d32e` (`git log --oneline 50b3a02..HEAD`). The full-suite gate ran at `784c517`; the final-review fix wave added `582dacc`, `8499b51`, `fa5d550` and `1a9d32e` (the last head, the one the rerun below ran at).
- Node v24.21.0, pnpm through corepack, Windows 11, Chromium through Playwright (production build, `PLAYWRIGHT_PORT=3105 PLAYWRIGHT_WORKERS=2`).
- Guarded disposable local stack `scoperoom-stage04-test`, API on 59321 (59xxx ports), database `127.0.0.1:59322`. `.env.local` targets only this stack; the guard refuses anything else.
- `@supabase/realtime-js` / supabase-js 2.117.1. Local Auth 2.196.0, Realtime 2.130.0, CLI 2.117.0 as recorded in the [probe](2026-09-30-browser-token-probe.md) (taken on the sibling Stage 03 stack of the same CLI); Stage 04.1 recorded the same Realtime 2.130.0 on this stack. The versions were not re-read from the Stage 04 stack for this document.

## Provider settings

- Tenant `private_only` (public channels refused). The local container re-seeds its tenant as public on every start, so `db:migrate` must run again after a restart; `test:realtime` fails closed until it does. `db:migrate` was rerun in this wave: `realtime=apply-ok`, `realtime=verify-ok`, no pending migrations.
- Browser credential (E36): the server mints a separate five-minute token (`role: app_realtime_client`, `iss: scoperoom`, `aud: scoperoom-realtime`, `exp = iat + 300`, `profile_id`, `project_id`, `realtime_epoch`; no `sub`, `session_id` or email). Locally signed HS256 with the local stack's JWT secret through `SCOPEROOM_REALTIME_SIGNING_ALG/KEY/KID` (names only in `.env.example`; missing or mismatched configuration fails closed with 503). Setup and policies: [realtime-setup.md](../../realtime-setup.md).
- Credential-boundary matrix, `tests/realtime/token-boundary.test.ts`, 3 tests, all pass (part of `test:realtime` 13/13), using tokens minted by the production signer and real sockets:
  - Join, send and receive exactly what each member scope allows (owner, editor, viewer; a stranger, a removed member, another project's scope, a stale epoch and forged claims get nothing), each denial paired with a positive control on the same channel.
  - The helper denies malformed, `sub`-bearing and role-mismatched claims without raising; expired and tampered tokens are refused as credentials (provider wording, not the RLS wording).
  - Auth: `GET user`, `PUT password`, `PUT email`, `POST factors` answered 403 `bad_jwt` and `GET admin/users` 403 `not_admin`, with an ordinary token's 200 as the control and the account verified unchanged afterwards. Data API and Storage answered 4xx differently from an ordinary token, never 5xx.

## Commands and results

| Command | Result |
| --- | --- |
| `corepack pnpm lint` | pass (at `784c517` and at `1a9d32e`) |
| `corepack pnpm typecheck` | pass (both) |
| `corepack pnpm build` | pass (both) |
| `corepack pnpm test:unit` | 311/311 at `784c517`; **312/312** at `1a9d32e` (+1: one clock read for `snapshot`/`nextExpiry`) |
| `corepack pnpm test:integration` | 87/87 at `784c517` (not rerun after the wave: no server or SQL change) |
| `corepack pnpm test:realtime` (serial, alone on the stack) | 13/13 at `784c517`, zero skips (not rerun: no SQL or server change; `db:migrate` rerun, `verify-ok`) |
| `corepack pnpm db:migrate` | `prepare-ok`, no pending migrations, `apply-ok`, `verify-ok` at `1a9d32e` (DEP0190 deprecation warning is noise from `migrate.mjs`) |
| `test:e2e:production` (whole suite) at `784c517` | 223 passed, 1 failed, 5 did not run, 13.0 min. The failure and five not-run are all `access.spec.ts` (limitation below) |
| `access.spec.ts` alone with a temporary allowlist edit (added 59321, reverted with `git checkout`, never committed) | 10/10 |
| `test:e2e:production tests/e2e/collaboration-live.spec.ts collaboration-presence.spec.ts collaboration-a11y.spec.ts` at `1a9d32e` | 11/11 (1.5 min) |
| Four `studio-*` specs (controls, shape panel, review polish, flow switcher) after the narrow-layout CSS change | 11/11 |

`access.spec.ts` limitation: it has a hard-coded local-port allowlist that excludes the 59xxx guarded stack, so its first test fails and the rest depend on it. With the allowlist temporarily extended it passes 10/10. The same limitation applied to the 04.1 and 04.2 evidence. The whole suite was not rerun after the final wave (223 + 3 new a11y specs passing in focused runs); the wave touched the overlay clock read, one CSS block, `migrate.mjs` and docs.

### First full run (at `d668567`): 210 passed, 14 failed (13 real + `access`), 5 not run

The 13 real failures, and how Task 7 resolved them:

- One product root cause, 10 failures. A window focus was coalesced into any in-flight non-poll read, which was written when only window events and writes started such reads; 04.3 added the Realtime `subscribed` (join) and `hint` reads, which can start just before a focus, so the focus was folded into a read that began before it. `collaboration-writes.spec` (7 tests, plus the `:279` write-before-status case), `collaboration-auth-outage.spec:157` and `collaboration-polling.spec:48` failed through it. Fixed in `6ebb558` (the exemption for `poll` also covers `hint` and `subscribed`; a focus queues its own read; RED/GREEN unit test). The `:279` case was investigated as a possible write-barrier regression and is not one: in real use focus follows blur or hide, both invalidate authority, so a write cannot leave before re-proof.
- Three test-side failures, fixed in `784c517` without weakening assertions: `collaboration-polling.spec:9` counted the join's status read as a second poll (the invariant is one timer, not a read budget; the test now waits for each join read), `collaboration-notices.spec:155` counted the join read as a second failed saved read (the step now starts after the join read), and `collaboration-live.spec:77` moved the editor's mouse onto the shape panel (the test now uses a point on the flow with an `elementFromPoint` precondition).
- `collaboration-notices.spec:80` once failed with `net::ERR_NO_BUFFER_SPACE` in `signIn` (Windows socket exhaustion with two workers); environmental, passed in every other run.

## Real sockets versus fake transports

- Real provider sockets (what they prove): `tests/realtime/*` (13 tests) use real Auth sessions and real scoped tokens against the local Realtime tenant and prove the authorization boundary (policies for both topics, forged claims, rotation, downgrade, archive, the four-field hint), revocation behaviour and the committed-hint path. `collaboration-live.spec` drives real browsers through a forwarding `page.routeWebSocket` proxy to the real provider with the real token route: live previews, lost hints, outage and rejoin, real token renewal through the heartbeat, and adversarial packets sent from a real editor credential on the real collab channel. Every injected fault is paired with evidence that the provider did its part (hints counted and withheld, joins counted).
- Fake transports and clocks (what they prove): `tests/collaboration-sync.test.ts`, `collaboration-transport.test.ts`, `collaboration-previews.test.ts` and the parser tests use an injected transport, timers and clock. They prove controller logic only: generation fences, coalescing and timers, the preview store's ordering and context rules, parsers. They say nothing about provider behaviour. The e2e proxy cuts sockets and withholds frames at the WebSocket layer (a simulated outage, not a provider one) and some specs freeze or advance the page clock (lost-hint polling, heartbeat renewal).

## Active-socket revocation observation

`tests/realtime/revocation.test.ts` (real sockets): Realtime enforces the credential's `exp` on joined channels, but membership removal is not pushed to an already-joined socket. After removal the backend (API reads and saves) denies the member at once, a fresh old-epoch join is refused, and remaining members are moved to the new epoch. The removed member's already-joined socket still received and sent old-topic traffic until its credential expired. That window is bounded by the 300 s credential lifetime plus a heartbeat. Epoch rotation retires the topics for everyone who rejoins. There is no instant eviction.

## Privacy limits

- Nothing on the wire carries a display name, label or email: peer packets are geometry and node ids; Presence carries ids and a flow/selection claim. Names are resolved in the browser from the members list.
- Presence identity is an advisory claim: each browser reports who it is and what it has selected; it is not verified and does not show who made a change. The UI says so. A spoofed claim grants nothing (RT-022): identity for authority comes only from the server-side credential and the database.
- No promise of instant eviction, and no erasure of metadata a removed member's socket already received before the credential expired (presence, cursors, drag geometry, hints).

## Accessibility

Automated, production build, `tests/e2e/collaboration-a11y.spec.ts` (3 tests, pass) plus existing specs:

- Keyboard-only: from the flow title one Tab reaches the participants toggle; Enter and Space open it (`aria-expanded`), Escape closes it and returns focus to the toggle; the closed list is `hidden` (not reachable). During a cut Realtime the quiet "Live updates delayed" status note appears without a dialog and without moving focus, the toggle still works by keyboard, and the note clears on reconnect without stealing focus. The delayed note has no control of its own (recovery is automatic); the keyboard operation of the Save and recovery notices is covered by `collaboration-notices.spec` (Save focused and activated with Enter).
- Visible focus: the toggle shows the global `:focus-visible` ring (2 px solid).
- 390 px: the Studio header with the participants control has no horizontal overflow, every toolbar button is inside the viewport, the toggle is at least 44 px tall. The spec found a real defect, fixed in `1a9d32e`: the open participants list was anchored to the toggle and ran 88 px off the left edge at 390 px; below 640 px it now spans the toolbar.
- Reduced motion: with no preference the cursor and ghost ease between packets (transition above 0); under `prefers-reduced-motion: reduce` both are 0 ms with no running animation, so outlines are static.
- No per-cursor announcements: the overlay is `aria-hidden="true"`, contains no focusable or role-bearing element and no `aria-live`, and a `MutationObserver` on every `aria-live`, `role=status` and `role=alert` region recorded zero changes during a live cursor and drag. The participant list and selection text are plain text (not live regions).
- NVDA: **not run (manual).** Stage 03's unverified NVDA check is not converted into a pass; no screen reader was run for Stage 04.3.
- Known gap: selection markers on canvas steps are colour dots (plus a `title` and screen-reader-only text). Sighted touch users have no title, so the marker is colour-only for them, a WCAG 1.4.1 gap for this advisory feature (the List view has text markers); canvas edges have no selection markers at all. Accepted as a deferred follow-up.

## Acceptance table (RT-001 to RT-028)

All rows pass locally at the commits above. "Live" means a real-provider test; "fake" an injected-transport test.

| Case | 04.3 status and proof |
| --- | --- |
| RT-001 | Pass. `collaboration-presence.spec` (named participants from the members list); live Realtime roster |
| RT-002 | Pass. `collaboration-live.spec` drag: temporary ghost, canonical step unchanged until the editor's Save, final position persists after reload |
| RT-003, RT-004, RT-005, RT-006 | Pass. Stage 03/04.2 guarantees hold with live Realtime on in the whole two-user suite (223 passed) and `tests/integration/positions.test.ts`; the drag spec shows previews change nothing saved |
| RT-007 | Pass. Adversarial packet spec (live) and preview-store sequence tests (fake): out-of-order packets dropped |
| RT-008 | Pass. Adversarial spec (live) and preview-store test: old base position version never moves a saved node |
| RT-009 | Pass. Outage spec (write waits for the post-rejoin status read), preview expiry within about 2 s, saved placement remains |
| RT-010 | Pass. Adversarial spec (other-flow packet) and cursor spec; store context checks |
| RT-011 | Pass. Adversarial spec (live: unknown node, wrong project) and `collaboration-messages.test.ts` (fake: non-finite and out-of-range coordinates rejected); no semantic write (draft, receipts, audit unchanged) |
| RT-012 | Pass. `policies.test.ts` and `revocation.test.ts` (live): reviewer/viewer keep Presence and receive, lose collab Broadcast |
| RT-013 | Pass. `policies.test.ts` (live): a browser send on the events topic is denied |
| RT-014 | Pass. `policies.test.ts` and `token-boundary.test.ts` (live): non-member, guessed topic, stale epoch and forged claims denied |
| RT-015 | Pass. Both channels SUBSCRIBED triggers `revalidate("subscribed")`, which invalidates authority and forces a status read (`project-sync.ts`; unit tests in `collaboration-sync.test.ts`, and the join read is observed in the browser specs), plus the 04.2 fetch-ordering protection |
| RT-016 | Pass. `collaboration-live.spec` lost-hints case: every hint withheld on a healthy socket (counted), the status timer converges, values asserted after reload |
| RT-017 | Pass. `collaboration-sync.spec` late read after receipt and project-switch stale-response cases, rerun with Realtime |
| RT-018 | Pass. Outage spec: real content and position Save succeeds while "Live updates delayed" shows; peers converge after rejoin |
| RT-019 | Pass. `notifications.test.ts` (enqueue failure still commits), polling discovery, lost-hints case. No dedicated browser fault runner (withdrawn by plan) |
| RT-020 | Pass. `revocation.test.ts` (live) and the 04.2 removal specs; active-socket observation above |
| RT-021 | Pass for 04.3 scope. Old-epoch and old-draft packets fail the context checks (unit, live adversarial); the reset API rerun stays in Stage 09 |
| RT-022 | Pass. Adversarial spec with an extra `userId` key: the packet grants and shows nothing |
| RT-023 | Pass. One status timer per controller across panel, view and project switches (`collaboration-polling.spec:9`); one controller owns the two private channels (`collaboration-transport.test.ts`) |
| RT-024 | Pass. Hidden-tab and blur cases in `collaboration-sync.spec` and `collaboration-writes.spec` (nothing sent until status answers), rerun with Realtime |
| RT-025 | Pass. Position-only saves in the two-user suite with live previews |
| RT-026 | Pass. `collaboration-sync.spec` unsaved undo after another person's saved move refused with `POSITION_CONFLICT` |
| RT-027 | Pass. `collaboration-live.spec`: a delivered preview followed by a failed API save stays unsaved |
| RT-028 | Pass. `notifications.test.ts` (live): exactly the four contract keys plus the provider `id`; `collaboration-messages.test.ts`: the parser tolerates only `id` |

## Rulings

- R1: the hosted feasibility check was skipped (no hosted change is authorized); implemented against the guarded local stack and recorded as outstanding below. If hosted cannot import a standby ES256 key or needs a broad grant, E36 must be redesigned before release.
- R2: the local probe evidence is committed at `docs/evidence/collaboration/2026-09-30-browser-token-probe.md` with a "hosted feasibility: not run" section.
- R3: the server signing adapter moved into Task 0 because the boundary matrix needs minted tokens.
- R4: signing configuration variables `SCOPEROOM_REALTIME_SIGNING_ALG` (HS256 or ES256), `SCOPEROOM_REALTIME_SIGNING_KEY` and `SCOPEROOM_REALTIME_SIGNING_KID`; fail closed when missing or mismatched; locally the stack's JWT secret, in CI exported from `supabase status`.
- Parked: the participants members read retries only when status, failures or roster change. A neutral "Unknown participant" grants nothing and needs `/members` to fail while `/status` succeeds unchanged; a 30 s one-shot retry is a one-liner if wanted. Names stay unknown until something changes.

## Outstanding hosted and CI evidence (not run)

- (a) Hosted ES256 standby-key feasibility (an imported key trusted for verification without signing user sessions) and the one named `GRANT app_realtime_client TO <role>` for the hosted Realtime connection: **NOT RUN.**
- (b) `helperProblems` in `scripts/db/realtime.mjs` and `tests/integration/realtime.test.ts` (`holders: 0`) currently reject any holder of the client role, so the hosted grant needs a deliberate reviewed change to both before hosted `verify` can pass.
- (c) Hosted `realtime.topic()` EXECUTE for the client role is unverified (locally Realtime connects as a superuser).
- (d) The CI `JWT_SECRET` export for the signing variables and a fresh `db:bootstrap` with the `20260930010000_realtime_client_credentials` migration have not run in CI yet.
- (e) Minors the final review triaged as safe to defer: a duplicated policy helper in `token-boundary.test.ts` (`clientAllows`); refused PUT password not proven by re-sign-in; no archived/deleting case for the custom branch; token source `renew().catch` skips degraded and can discard a cached token if an injected read rejects (production read never rejects); the test JWT helper fixes `iat`; the preview watermark is not advanced by rejected packets (narrow reordered-ghost window), sparse arrays accepted with holes, duplicate `uuid`/`uuids` helpers, the 64-session cap keeps roster order; persistent server `CLOSED` restarts every 5 s without backoff, a token-endpoint outage reports degraded with healthy sockets, a live connection outlives a stopped status controller until navigation; canvas markers colour-only for touch and no canvas edge markers; the drag e2e nudge is coalesced away; a mid-drag flow switch leaves a ghost until expiry; a timer-poll race in the final `runFor`; an owner-control assertion in `revocation.test.ts`; DEP0190 and pg concurrent-query deprecation warnings.
