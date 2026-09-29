# Architecture context

The [tracker](progress-tracker.md) distinguishes planned architecture from observed implementation.

| Layer | Responsibility |
| --- | --- |
| Next.js / React / TypeScript | One modular application, thin routes and feature services |
| React Flow / shared tokens | Controlled graph view, forms and accessible project shell |
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
- `src/features/drafts`: saved document/layout contracts, pure domain code (`domain/{graph,changes,moves}.ts`, shared by browser and server) and the server services; manual graph writes pass through the command dispatcher, the batch `changes` service or the `positions` service. `server/layout.ts` is the only home of `@dagrejs/dagre`; `scripts/check-boundaries.mjs` (run by `lint`) rejects it from client code.
- `src/features/studio/ui`: the Studio (canvas, shape panel, List, toolbox, Flows menu, inspector) and its `StudioProvider`; it reads the draft from the shell's project bootstrap and keeps a local outbox (`outbox.ts`) over it, replaying queued changes with the shared pure domain code so the screen shows what a save will produce.
- `src/client`: shared browser transport/auth/providers; feature hooks stay with their UI.
- `src/features/shell/ui` (the `/app` shell), `src/client` (browser fetch helper) and `src/styles/tokens.css`: shared presentation and tokens with safe props.
- `src/contracts`: runtime-neutral common wire schemas.
- `src/server`: trusted shared Node infrastructure; `src/server/web` isolates Next request/session wrappers.
- `src/trigger`: thin durable tasks; feature services stay usable without Next request state.
- Root configs, `.github/workflows`, `scripts`, `prisma`, `supabase` and optional Dockerfile: development/deployment tooling, outside application source.

UI may render on the server; browser helpers are not a home for every component. Enforce resolved imports against secret leaks and worker→Next coupling. Install packages/create folders with actual consumers. [Full source map](../../.codex/docs/implementation/v1.6/02-architecture-and-agent-playbook.md#source-layout-and-runtime-boundaries).

## Invariants

PostgreSQL owns both `documentJson` and `layoutJson` on the current draft. Entity/behavior/document/layout/position versions have distinct purposes. Final moves save touched positions with expected versions; conflicting same-target edits preserve local attempts for explicit recovery.

## Draft saves

The Studio queues every edit in a local outbox on top of an optimistic draft and saves it later (Save, 10 s autosave, or before Arrange and flow/project switches); nothing is saved on drop and new steps exist only in memory until then.

- `POST D/changes`: one transaction and one `Idempotency-Key` for up to 100 commands and 200 moves (per flow group), body up to 256 KiB. Each command keeps its own guards (exact revision or entity version); creates carry client-proposed final ids, so local ids are never remapped; moves carry expected position versions. Any refusal rolls back the whole batch and returns `{part, index}` details (a byte-cap refusal has none). A batch over the limits is split by the client into sequential all-or-nothing requests. The result and receipt hold only `{draftId, documentRevision, layoutRevision, eventSequence}` (plus `replayed`): a valid batch can create more ids than the 64 KiB receipt cap allows, so the browser keeps its proposed ids and re-reads the draft after a save.
- `POST D/positions` (`MOVE_NODES` up to 20 same-flow nodes, `ARRANGE_FLOW` with an exact revision pair and a preview hash recomputed under lock) is what Arrange applies; the Studio itself no longer sends `MOVE_NODES` or `D/commands`. `POST D/arrangement-preview` is nonmutating and keyless. Neither it nor `changes` has a rate limit yet (project-wide gap).
- `layout.edgeSides` (remembered connection sides, optional, `{}` in older drafts) lives in the layout, not the document: a sides-only change advances `layoutRevision` only, never `documentRevision`.
- Schema versions stay ScopeDocument v3 and DraftLayout v1 although the layout gained `edgeSides` and the document gained the `DATA_STORE` kind.

One project Realtime controller uses events/collab topics, current JWT policies, post-subscribe refetch and status reconciliation. Messages never write canonical records. Epoch rotation and backend authorization account for cached socket permissions; no instant-eviction promise.

Freeze copies an exact saved candidate. Publication advances the baseline while leaving newer draft content/positions untouched. Explicit reset alone archives/replaces the draft. Selected examples and reviewed links track behavior changes, not confirmation metadata.

Every protected read/write checks current access. Matching safe receipts replay before new-operation capability/version checks. AI stores exact input and durable intent, uses bounded fenced attempts and produces one reviewed application; it never approves.

Vercel owns native web deployments; GitHub checks gate production and pair compatible schema/workers. [Release](../../.codex/docs/implementation/v1.6/delivery/03-ci-cd-and-release.md) and [data contracts](../../.codex/docs/implementation/v1.6/data/01-relational-model.md) own details.

