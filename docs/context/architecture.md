# Architecture context

The [tracker](progress-tracker.md) distinguishes planned architecture from observed implementation.

| Layer | Responsibility |
| --- | --- |
| Next.js / React / TypeScript | One modular application, thin routes and feature services |
| React Flow / shared tokens | Controlled graph view, forms and accessible workspace |
| Supabase Auth | Verified identity/session; backend services decide project capability |
| Supabase PostgreSQL / Prisma | Saved document and layout, authority, evidence, snapshots, jobs, receipts and audit |
| Supabase Realtime | Private presence, temporary motion and minimal committed-change hints |
| Trigger.dev | Durable AI dispatch/repair and bounded maintenance, introduced with the first AI consumer |
| Explicit model provider / AI SDK / Zod | Captured typed proposals with human review and bounded costs |
| Vercel / GitHub | Native web deployments; required production checks and coordinated migrations/workers |
| Safe operational sink / SQL audit | Separate diagnostics from durable project actions and job truth |

## Source boundaries

- `src/app`: thin Next routes and authorized server composition; one active App Router root.
- `src/features/<feature>/{contracts,domain,server,ui}`: keep related changes together.
- `src/client`: shared browser transport/auth/providers; feature hooks stay with their UI.
- `src/components/{ui,workspace}` and `src/styles`: shared presentation/tokens with safe props.
- `src/contracts`: runtime-neutral common wire schemas.
- `src/server`: trusted shared Node infrastructure; `src/server/web` isolates Next request/session wrappers.
- `src/trigger`: thin durable tasks; feature services stay usable without Next request state.
- Root configs, `.github/workflows`, `scripts`, `prisma`, `supabase` and optional Dockerfile: development/deployment tooling, outside application source.

UI may render on the server; browser helpers are not a home for every component. Enforce resolved imports against secret leaks and worker→Next coupling. Install packages/create folders with actual consumers. [Full source map](../../.codex/docs/implementation/v1.5/02-architecture-and-agent-playbook.md#source-layout-and-runtime-boundaries).

## Invariants

PostgreSQL owns both `documentJson` and `layoutJson` on the current draft. Entity/behavior/document/layout/position versions have distinct purposes. Final moves save touched positions with expected versions; conflicting same-target edits preserve local attempts for explicit recovery.

One project Realtime controller uses events/collab topics, current JWT policies, post-subscribe refetch and status reconciliation. Messages never write canonical records. Epoch rotation and backend authorization account for cached socket permissions; no instant-eviction promise.

Freeze copies an exact saved candidate. Publication advances the baseline while leaving newer draft content/positions untouched. Explicit reset alone archives/replaces the draft. Selected examples and reviewed links track behavior changes, not confirmation metadata.

Every protected read/write checks current access. Matching safe receipts replay before new-operation capability/version checks. AI stores exact input and durable intent, uses bounded fenced attempts and produces one reviewed application; it never approves.

Vercel owns native web deployments; GitHub checks gate production and pair compatible schema/workers. [Release](../../.codex/docs/implementation/v1.5/delivery/03-ci-cd-and-release.md) and [data contracts](../../.codex/docs/implementation/v1.5/data/01-relational-model.md) own details.

