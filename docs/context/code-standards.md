# Code standards

## General and TypeScript

- Prefer small concrete modules, existing platform capabilities and shared feature services. Add abstractions/dependencies for current needs.
- Keep strict TypeScript; validate unknown input with the owning executable schema at each trust boundary. Avoid unchecked casts and broad `any`.
- Fix behavior at its shared owner. UI, routes, AI application and workers must not fork business rules.
- Preserve unrelated user changes and existing worktrees. Use `rg` for focused searches; use the active shell's native quoting and path handling.

## Next.js and styling

- Keep Next server composition in `src/app` and use `'use client'` at interactive boundaries. Feature UI and shared visual primitives may render as Server Components; `src/client` holds shared browser adapters/hooks/providers, not every component.
- Keep handlers thin: bound/parse input, resolve identity, invoke the feature service, return the documented envelope.
- Keep credentials and privileged clients out of browser imports. Next cookie/session/HTTP wrappers belong in `src/server/web` with `server-only`; shared `src/server` infrastructure and feature services stay compatible with plain Node/Trigger.
- A Server Component may render a Client Component. Client Components still need safe server prerendering: access browser APIs in effects/events or an explicit browser-only loading boundary, not module initialization or initial render. Pass authorized, serializable view data across the boundary.
- Private authenticated data must not enter public caching. Follow the installed framework/Auth integration contract.
- Use semantic tokens from [UI context](ui-context.md). Reuse accessible controls and field editors as they gain real consumers.

## API, data and storage

- For receipt-bearing mutations, preserve the documented order: current access and scope → matching completed receipt replay → capability and lifecycle/version checks for new work. Replays must not leak inaccessible results or fail merely because successful work already advanced the version.
- Persist domain changes, required audit/receipts and project resource cursors atomically; external effects happen after commit. Database hints are optional notifications; AiRun is its own durable dispatch intent.
- Use one Prisma application migration history with restricted runtime roles. Supabase manages its Auth schema.
- Introduce tables and foreign keys in their owning stages; validate the actual database target before provisioning/migration/maintenance.
- Store bounded normalized text and canonical semantic JSON and saved layout in PostgreSQL as specified. Do not introduce blob storage, Redis or another source of truth for convenience.
- Use safe error codes/log metadata. Never log source bodies, prompts, invitation tokens or secrets by default.

## Organization and verification

Follow [feature ownership and dependency direction](../../.codex/docs/implementation/v1.5/02-architecture-and-agent-playbook.md). A small feature may start with a few files; no empty directory scaffolding is required. Shared primitives/HTTP schemas belong in `src/contracts`; feature contracts stay with their feature. Cross-feature imports use explicit public modules. Do not mix UI/server/contracts through a feature-wide barrel, or make pure domain/contracts depend on services or runtime adapters.

Folder names are conventions, not security controls. Enforce resolved import boundaries in the existing ESLint configuration, covering aliases, relative paths, re-exports and dynamic imports. If needed, use the existing TypeScript resolver in a small `scripts/check-boundaries.ts` invoked by `lint`. Reject unresolved computed application imports that bypass those checks. Validate forbidden browser-to-secret and worker-to-Next paths plus legitimate Server Component/Client Component composition, following the [stack boundary contract](../../.codex/docs/implementation/v1.5/03-stack-and-compatibility.md#source-boundaries). Do not ban valid pure contract sharing merely because the containing features refer to one another.

Read the current [package scripts](../../package.json) first. Stage 01.1 migrated to a reviewed pnpm lockfile and added `typecheck` and `test:unit`; on this machine invoke pinned pnpm through `corepack pnpm`. Database, browser and provider test scripts are introduced only with real consumers. Use the selected lockfile consistently.

Run checks appropriate to the change: static checks/build for affected application code, real PostgreSQL tests for transaction/authorization behavior, and browser/keyboard checks for visible UI. A docs-only change needs content/link/consistency checks. Add meaningful regressions for behavior changes; do not create empty passing suites or tests that only repeat implementation details.

Record actual commands and results, including failures or unavailable prerequisites. Local adapters are not hosted-provider evidence. The complete command catalogue and activation rules remain in [testing and evaluation](../../.codex/docs/implementation/v1.5/delivery/02-testing-and-evaluation.md); compatibility and package pins remain in the [stack plan](../../.codex/docs/implementation/v1.5/03-stack-and-compatibility.md).
