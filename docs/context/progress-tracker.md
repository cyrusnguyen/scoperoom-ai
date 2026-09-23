# Progress tracker

Last updated: 2026-09-24. This records the Stage 01 foundation, blank-canvas UI checkpoint and Prisma 7 upgrade.

## Current step

Stage 01 is complete. The current checkpoint adds a blank canvas and basic workspace sections only. The user deferred Supabase Auth and the login screen to the next PR.

## Implemented in this working tree

- The root page renders a responsive blank canvas with a workspace guide and shared context panel, using Atlas Outline colors as reference. Workspace styles are co-located with the component; global CSS holds only tokens, reset and the skip link. Empty states name the missing project and content. No project data, editing, AI, invite, review or Auth controls are presented.
- Node 22.20.0 and Corepack pnpm 10.28.2 configuration, frozen lockfile, lint/import boundaries, typecheck, unit tests, build, health endpoint and a Chromium shell test.
- One private `app` Prisma migration with only `EnvironmentIdentity` and `TransactionFixture`, plus local bootstrap/migration guards and scoped migrator, web and worker roles. No product-content tables yet.
- A GitHub Actions workflow for static/build, local database integration and Chromium checks. All three jobs passed on the feature commit and merged main.
- `.env.example` lists current foundation variables and commented future provider placeholders. The ignored `.env.local` holds local values; Node database scripts load it automatically, while CI supplied environment values take precedence.

## Verification

- The Stage 01 reduced dependency set remains in place; no Supabase Auth packages or structural schema changes were added in this checkpoint. Lint, typecheck, 9/9 unit tests and Next build passed locally for the blank UI.
- Chromium 3/3 passed against a locally running Next server on Windows, covering health, blank canvas, theme, skip-link focus and a 390px layout with all sections reachable and no horizontal overflow. Desktop and mobile screenshots were inspected. On Windows, start `corepack pnpm exec next dev --hostname 127.0.0.1 --port 3100` in a separate terminal before `corepack pnpm test:e2e:chromium`; Playwright starts its own server in CI/Linux.
- Prisma CLI, Client and PostgreSQL adapter are pinned to 7.10.0. The datasource URL moved from the schema into `prisma.config.ts`; the generated TypeScript client lives under ignored `prisma/generated` and loads in plain Node. `prisma validate`, `prisma format --check` and `db:generate` pass without a database URL, matching the CI generation step. Lint, typecheck, 10/10 unit tests and Next build passed after the upgrade.
- An isolated loopback Supabase stack freshly applied the sole migration under Prisma 7; 4/4 PostgreSQL/pooler integration tests passed, including role and transaction boundaries. The test helper now reads PostgreSQL error codes from Prisma 7's nested driver-adapter cause. The existing local project database was not used.
- The earlier setup-node pin and missing generated Prisma Client failures were corrected. Hosted run `35856913520` on feature commit `005033c` and run `35857215746` on merged main commit `b96ffa7` each passed static/unit/build, database integration and Chromium. PR #2 is merged. The shell has no real sign-in, data persistence or collaboration path.

The earlier [01.1](../evidence/foundation/01-1.md), [01.2](../evidence/foundation/01-2.md) and [01.3](../evidence/foundation/01-3.md) notes describe earlier, broader snapshots and are historical. [Dependencies](../evidence/foundation/dependencies.md) records the reduced package set.

## Next action

Review and merge the blank-canvas UI checkpoint. In the next PR, implement `/login` and Supabase Auth, then protect the canvas. Product tables, editing and AI remain later steps; the archived handbook is reference material.
