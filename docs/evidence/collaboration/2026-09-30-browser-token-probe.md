# Browser Realtime credential feasibility - 2026-09-30

Planning evidence for E36 and Stage 04.3. No application implementation or hosted configuration is claimed complete.

## Environment and method

Main checkout d454902; Node 24.21.0, supabase-js/realtime-js 2.117.1, local Auth 2.196.0, Realtime 2.130.0, CLI 2.117.0. Used the running, separate `scoperoom-stage03-test` stack (API 127.0.0.1:58321). The Stage04 stack, active04.2 worktree and hosted environment were untouched.

A one-off Node probe read local keys into memory without printing them. It created one disposable confirmed Auth account and a uniquely named NOLOGIN/NOINHERIT/NOSUPERUSER/NOBYPASSRLS role. The role received only realtime schema USAGE and messages SELECT/INSERT; no membership grant to authenticator. Two temporary policies allowed broadcast/presence for one exact random topic, profile claim and project claim. This isolates provider feasibility: these test policies are not the planned SQL membership/epoch helper.

A normal signed user token provided a positive Auth control. The scoped HS256 JWT had a five-minute expiry, the dedicated role, issuer/audience labels and random profile/project claims, with no sub or session_id. Two real SDK socket clients used it. Awaiting realtime.setAuth(token) before channel creation/subscription was necessary: the first attempt raced the SDK's asynchronous initial accessToken callback and joined as unauthorized. Its temporary resources were cleaned before the corrected probe.

## Observed results

| Probe | Result |
| --- | --- |
| Ordinary user JWT: GET /auth/v1/user | 200 positive control |
| Scoped JWT: GET /auth/v1/user | 403 bad_jwt |
| Scoped JWT: PUT /auth/v1/user password | 403 bad_jwt |
| Scoped JWT: PUT /auth/v1/user email | 403 bad_jwt |
| Scoped JWT: POST /auth/v1/factors (TOTP) | 403 bad_jwt |
| Scoped JWT: GET /auth/v1/admin/users | 403 not_admin |
| Private channel join without sub | SUBSCRIBED |
| Broadcast between two real clients | Acknowledged and received |
| Presence tracking | Acknowledged |
| Other topic / mismatched profile claim | Channel authorization denied |
| GET /rest/v1/ with scoped JWT | 403 |
| GET /storage/v1/bucket with scoped JWT | 400 |
| Cleanup | Channels removed/disconnected; temporary policies and role dropped; test Auth account deleted; role/user absence confirmed |

No tokens, signing secrets, account passwords or business content were logged or retained. The successful probe exited 0.

## Interpretation and limitations

The supported custom-token path can authenticate private Realtime without exposing a normal Auth user credential. Auth's mandatory subject check supplies the tested account-endpoint boundary. Changing audience alone would not do so; omission of session_id alone would not do so either. The dedicated database role and RLS supply the Realtime authorization boundary.

This is a narrow feasibility probe, not the application test suite. It does not prove current application membership/epoch checks, downgrade/archive behavior, refresh/expiry teardown, a complete Storage operation matrix, private-only hosted configuration, ES256 hosted signing, or hosted role privileges. Presence acknowledgement is not evidence of the final named-participant UI. Implement reproducible token-boundary tests and the full role/capability matrix in 04.3; repeat on the actual hosted release target. No global Auth account-policy changes or CLI upgrade are required by this selected design.

## Primary sources checked

- [Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys): custom JWT sub is optional; role names a database role; imported private-key workflow and key IDs. Supabase-generated private keys are not exportable.
- [Supabase JWT guide](https://supabase.com/docs/guides/auth/jwts): custom token support through accessToken.
- [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization): private-channel RLS and cached permissions.
- [Auth v2.196.0 authentication source](https://github.com/supabase/auth/blob/v2.196.0/internal/api/auth.go): requireAuthentication parses JWT and loads a mandatory subject; session_id lookup is optional; admin operations separately require admin role.
- [Realtime v2.130.0 socket authentication](https://github.com/supabase/realtime/blob/v2.130.0/lib/realtime_web/channels/user_socket.ex): role and exp are required claims.
- [Realtime v2.130.0 authorization](https://github.com/supabase/realtime/blob/v2.130.0/lib/realtime/tenants/authorization.ex): database role and request JWT claim context for policy evaluation.

Current Supabase changelog was also checked for managed Realtime-schema restrictions. The plan keeps helper functions in app_private and uses supported policies/grants on realtime.messages.

## Hosted feasibility: not run (outstanding release check)

No hosted or staging project was available or authorized for Task 0, so nothing below was checked on the real provider. Both items must pass before release; if either fails, return to the E36 decision.

- An imported ES256 key can be trusted for verification (for example as a standby key) without becoming the key Auth signs user sessions with. NOT RUN.
- The hosted Realtime database connection can switch to `app_realtime_client` through one named, narrow role-membership grant (record the exact `GRANT app_realtime_client TO <role>`), never through `authenticator`, `authenticated` or a broader role. Locally Realtime connects as a superuser, so no grant was needed or made. NOT RUN.

## Reproducible local boundary test

The probe above was one-off. The application-owned, repeatable version is `tests/realtime/token-boundary.test.ts` (run with `corepack pnpm test:realtime`). It mints credentials with the production signer (`src/features/collaboration/server/sign-token.ts`, unit-tested in `tests/realtime-sign-token.test.ts`) and covers the role/capability matrix, expired and tampered tokens, and the Auth, Data API and Storage refusals with positive controls. Its results belong in the Stage 04 evidence file; this document records only the design probe.
