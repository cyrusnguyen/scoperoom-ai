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

The Studio queues graph edits in a local outbox on top of an optimistic draft and saves it later (Save, 10 s autosave, or before Arrange and flow/project switches); nothing is saved on drop and new steps exist only in memory until then.

- `POST D/changes`: one transaction and one `Idempotency-Key` for up to 100 commands and 200 moves (per flow group), body up to 256 KiB. Each command keeps its own guards (exact revision or entity version); creates carry client-proposed final ids, so local ids are never remapped; moves carry expected position versions. Any refusal rolls back the whole batch and returns `{part, index}` details (a byte-cap refusal has none). A batch over the limits is split by the client into sequential all-or-nothing requests. The result and receipt hold only `{draftId, documentRevision, layoutRevision, eventSequence}` (plus `replayed`): a valid batch can create more ids than the 64 KiB receipt cap allows, so the browser keeps its proposed ids and re-reads the draft after a save.
- `POST D/positions` (`MOVE_NODES` up to 20 same-flow nodes, `ARRANGE_FLOW` with an exact revision pair and a preview hash recomputed under lock) is what Arrange applies; graph editing in the Studio no longer sends `MOVE_NODES` or `D/commands`. `POST D/arrangement-preview` is nonmutating and keyless. Neither it nor `changes` has a rate limit yet (project-wide gap).
- `layout.edgeSides` (remembered connection sides, optional, `{}` in older drafts) lives in the layout, not the document: a sides-only change advances `layoutRevision` only, never `documentRevision`.
- `RECONNECT_EDGE` also compares its inspected `expectedSides` pair (missing/null means no remembered points), so concurrent side changes cannot silently overwrite one another. Explicit reapply refreshes that targeted guard; an uncertain retry retains its original body and key.
- Scope commands (`CONFIRM_FLOW`, `CREATE/UPDATE/DELETE/CONFIRM_REQUIREMENT` and `ADD/UPDATE/CONFIRM/DELETE_TRACE_LINK`) use `POST D/commands` after save-first, never `D/changes`. The server checks immutable same-project citations and assignable owner roles. Requirement labels come from the locked `project.requirement_display_sequence` and are never reused; link confirmation checks the inspected endpoint behavior versions. Step and flow deletion removes incident trace links, member removal and leave unassign current requirements, and allocated ids avoid every document collection.
- Schema versions stay ScopeDocument v3 and DraftLayout v1 although the layout gained `edgeSides` and the document gained the `DATA_STORE` kind.

## Saved-update polling (Stage 04.2)

Saved changes by other people reach an admitted reader through the authenticated API; Realtime (Stage 04.3, below) only hints that a read is due and never carries saved content.

- **One controller per open project.** `SyncProvider` (`features/collaboration/ui/sync-context.tsx`, mounted by the shell and keyed by project) owns one `createProjectSync` controller (`project-sync.ts`, pure, effects injected). Canvas, List, inspector and Details share it; none starts a timer or status read of its own. Switching projects disposes the old controller (timer, listeners, generation) and starts a new one.
- **Cadence.** A recursive timeout after each completed `GET status`: about 10 s with ±10% jitter, doubling per failed read to a 30 s cap; paused while the tab is hidden; focus, `online` and visibility return revalidate at once. A change of `eventSequence` alone fetches nothing; a changed `documentRevision`/`layoutRevision` triggers one coherent `D` read; a role, lifecycle or replaced-draft change reloads the bootstrap.
- **Admission gate and floor.** A saved read is adopted only when it is for the current generation and draft, not older than the adopted saved draft (`isNewer`), and covers the acknowledged-receipt floor (`StudioUi.acknowledgedRevisions`). Until a covering read lands, the Studio shows the outbox's acknowledged local replay, so a receipt followed by a stale read (or the reverse) never hides a saved edit.
- **Advance or freeze.** The pure `advance()` (`outbox.ts`) moves the outbox's frozen base to an adopted read only when every request the outbox could still send, including after undo or redo, would keep the guard it captured. Otherwise the view stays frozen, the newer saved changes are adopted in the background, and the Studio says so. Captured guards are never rewritten; a refused or uncertain `sending` segment stays byte-for-byte and only its exact retry or an explicit choice resolves it.
- **Write barrier.** Every dependent write (autosave, Save, Arrange Apply, Create/Duplicate flow, save-first switches, later batches of a split save) awaits `beforeWrite`. After a focus, blur, hide, reconnect or failed read the authority is invalid until a status read that started afterwards succeeds; 403/404 refuse the write with nothing sent, 503 shows Not saved and keeps the edit. Between events a valid controller lets writes through: the server still checks membership on every request.
- **Identity.** `ProjectStatusView.viewerId` (the caller's profile id) is compared on every status and bootstrap; a different account tears the shell down and navigates, sending nothing. `readRoute`/`mutationRoute` (`src/server/web/api-request.ts`) classify Supabase Auth failures: a definitive denial is 401, an Auth outage is 503 `UNAVAILABLE`, so an outage never signs anyone out.
- **Access loss.** A 404 status drops the project (`dropProject`); a 403 shows the error/recovery view without dropping it. Either way late responses cannot repopulate state and unsaved edits are not sent. A downgrade to a role that cannot edit leaves the edits shown for copy or discard.

## Sources (Stage 07a)

Sources are immutable text versions owned by PostgreSQL; the browser never saves them through the draft.

- Routes: `GET`/`POST /api/projects/:id/sources` (paginated list; paste or strict UTF-8 upload), `GET`/`PATCH .../sources/:sourceId` (one authorized head independent of list/filter; archive/restore, nickname), `GET`/`POST .../sources/:sourceId/versions` (paginated versions; correction creates a new version), and `POST D/graph-sources` (saved flow extract bound to the draft, its revision and the flow). Every write is keyed and replayable; correction and archive/restore check the expected record version, and the flow extract checks the draft revision; corrections send the expected record and current version ids.
- A saved-flow origin stores the draft, revision, flow and the selected step and connection ids (extract order). `origin_draft_id` is a same-project FK to the draft (`DEFERRABLE INITIALLY DEFERRED`, so a project delete cascades), and the `source_version_origin_binding` CHECK ties the origin's `copiedTextHash` and `promotedBy` to the version's own `content_hash` and `created_by`. The origin is capped at 32 KiB.
- Normalization drops exactly one leading BOM; text that still starts with a BOM is refused as `INVALID_INPUT`.
- `sources_revision` is a project status cursor advanced by user source writes and by AI prompt admission (which also stamps the prompt source's `last_event_sequence`), so other readers refresh the list through the normal status poll.
- Capacity: user documents (`USER_TEXT`, `USER_UPLOAD`, `PROMOTED_GRAPH`) take one of 30 active slots; archiving frees a slot and restore needs one. Every retained version, internal evidence included, counts against 500 versions and 500,000 code points per project. A single submission is at most 50,000 code points.

## Browser Realtime (Stage 04.3)

Pointer-drop entries carry local-only drag-start position metadata. Wire commands preserve that original guard; optimistic replay may retain attempted geometry after conflict without rewriting the request. An explicit reviewed rebase chooses fresh guards. Inspector coordinate buffers separately retain the position version they were typed against and participate in project dirty/recovery state.

- **Credential.** The browser never gets its Auth token for Realtime. `POST /api/projects/:id/realtime-token` (identity and membership checked, same-origin, `no-store`) returns a five-minute token with role `app_realtime_client` and only `profile_id`, `project_id` and `realtime_epoch` claims, signed from `SCOPEROOM_REALTIME_SIGNING_*`; the client renews it before expiry through the heartbeat. Authorization is the `can_realtime` helper plus the database role, as in Stage 04.1.
- **Channels belong to the sync controller** (`project-live.ts`, `realtime-transport.ts`): the events channel carries committed-change hints, the collab channel carries Presence and throttled cursor/drag previews. A hint or SUBSCRIBED only calls `revalidate`; previews are advisory, parsed strictly, checked against the adopted saved draft and expire after about 2 s. A failed or degraded Realtime shows "Live updates delayed", switches polling to the 5 s cadence with no second timer, and never blocks saving. An epoch or draft change rejoins under a new generation.
- **Limits.** Presence identity is an unverified claim and names come from the members list. Realtime enforces the credential expiry on joined sockets but does not evict a removed member at once (bounded by the 300 s credential plus a heartbeat). Evidence: [stage-04.md](../evidence/collaboration/stage-04.md).

One project Realtime controller uses events/collab topics, current JWT policies, post-subscribe refetch and status reconciliation. Messages never write canonical records. Epoch rotation and backend authorization account for cached socket permissions; no instant-eviction promise.

## Review candidates (Stage 9.1)

`src/features/reviews` owns the pure candidate checker and agreed-scope projection, strict wire contracts and authorized preview/freeze/history/withdrawal services. Included flows and requirements need current confirmation; included trace links need current endpoint review. The checker validates graph paths and every captured citation. It compares included meaning with the current baseline without treating layout, confirmation metadata or revision counters as semantic changes.

Freeze copies the exact saved document, layout, cited source versions and approval policy into an immutable snapshot. It checks the inspected document/layout revisions, baseline parent and policy version under existing project/draft locks. Snapshot hashes exclude mutable review state. Same-project foreign keys, immutable bindings and restricted column grants prevent cross-project lineage and premature publication authority. `reviewsRevision` uses the audit event sequence; `baselineSequence` remains zero.

Current read access precedes exact receipt replay; new writes then require owner/editor authority and an active project. Withdrawal closes an open candidate without changing its snapshot. Effective policy changes, loss of approver eligibility and archive supersede the open review atomically; restore does not revive it. Historical reads validate captured payloads and hashes and never substitute newer draft or source content.

Stage 9.2 owns decisions, publication and approved Markdown. Normal publication must preserve the current draft and newer content/positions. Reset and replacement remain deferred.

Every protected read/write checks current access. Matching safe receipts replay before new-operation capability/version checks. AI stores exact input and durable intent, uses bounded fenced attempts and produces one reviewed application; it never approves.

Vercel owns native web deployments; GitHub checks gate production and pair compatible schema/workers. [Release](../../.codex/docs/implementation/v1.6/delivery/03-ci-cd-and-release.md) and [data contracts](../../.codex/docs/implementation/v1.6/data/01-relational-model.md) own details.

