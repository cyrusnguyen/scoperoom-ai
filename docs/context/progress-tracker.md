# Progress tracker

Last updated: 2026-09-23. This records the agreed Stage 01 skeleton and observed hosted results, not the archived stage plan.

## Current step

Stage 01 is complete for the owner-approved minimal foundation: a basic accessible UI shell, build and test tooling, a health endpoint, and a guarded private PostgreSQL migration. The sign-in screen and real Auth belong to a later step.

## Implemented in this working tree

- One `src/app` App Router page with a skip link, a plain workspace placeholder and an explicit indication that project data is not connected. No functional flow, AI, invite, review or Auth controls are presented.
- Node 22.20.0 and Corepack pnpm 10.28.2 configuration, frozen lockfile, lint/import boundaries, typecheck, unit tests, build, health endpoint and a Chromium shell test.
- One private `app` Prisma migration with only `EnvironmentIdentity` and `TransactionFixture`, plus local bootstrap/migration guards and scoped migrator, web and worker roles. No product-content tables yet.
- A GitHub Actions workflow for static/build, local database integration and Chromium checks. All three jobs passed on the feature commit and merged main.
- `.env.example` lists current foundation variables and commented future provider placeholders. The ignored `.env.local` holds local values; Node database scripts load it automatically, while CI supplied environment values take precedence.

## Verification

- Current reduced dependency set: `corepack pnpm install --frozen-lockfile`, lint, typecheck, 9/9 unit tests and Next build passed locally.
- Chromium 2/2 passed against a locally running Next server on Windows, covering health, shell and skip-link focus. On Windows, start `corepack pnpm dev -- --hostname 127.0.0.1 --port 3100` in a separate terminal before `corepack pnpm test:e2e:chromium`; Playwright starts its own server in CI/Linux.
- An isolated loopback Supabase stack freshly applied the sole migration; the independent verifier found only the two app tables and the intended roles, passed 4/4 PostgreSQL/pooler integration tests and confirmed the wrong-environment guard failed before deploy. The original nonempty local database was preserved.
- The earlier setup-node pin and missing generated Prisma Client failures were corrected. Hosted run `35856913520` on feature commit `005033c` and run `35857215746` on merged main commit `b96ffa7` each passed static/unit/build, database integration and Chromium. PR #2 is merged. The shell has no real sign-in, data persistence or collaboration path.

The earlier [01.1](../evidence/foundation/01-1.md), [01.2](../evidence/foundation/01-2.md) and [01.3](../evidence/foundation/01-3.md) notes describe earlier, broader snapshots and are historical. [Dependencies](../evidence/foundation/dependencies.md) records the reduced package set.

## Next action

No further Stage 01 work is required for the agreed skeleton. Before a new stage, sync the local main branch with merged PR #2 and agree its scope. Keep subsequent UI, Auth, product tables and AI as separate steps; the archived handbook remains reference material.
