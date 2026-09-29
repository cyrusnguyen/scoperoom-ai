# UI context

Atlas Projects (`.worktrees/atlas-projects`, decision E30) is the visual and interaction reference; its synthetic data, local storage and simulated AI are never copied. Its palette is the Atlas Outline palette. Bring over UI with the feature that first uses it; a reference screen is not evidence that a feature works.

## Composition

`/app` is one shell: a collapsible Projects sidebar (Owned / Shared / Archived / Invites, about 300 px), a centre editor, and one on-demand right panel (about 360 px, closed by default). Stage 02R ships the panel's Details tab only; AI arrives in Stage 06 and Specs in Stages 07/11. `resolveDock` (`src/features/shell/ui/dock.ts`) docks the right panel first and the sidebar second, never narrowing the editor below min(W, 560); a panel that cannot dock opens as a focus-trapped overlay only if it was opened last. Closed panels reserve no width. There is no second inspector or navigation sidebar.

The shell (`src/features/shell/ui/project-shell.tsx`) lives in the `/app` layout and survives project switches. It holds a per-project in-memory UI store (panel state and unsaved field values); the editor and right panel under it are keyed by project, so a switch unmounts the previous project's UI observation, and a switch with unsaved values asks Stay or Discard. Only presentation preferences (sidebar open, list tab) are kept in sessionStorage. Tokens live in `src/styles/tokens.css`, and no other stylesheet writes a colour literal. [UI foundations](../../.codex/docs/implementation/v1.6/ui/00-interface-foundations.md) owns the component inventory, docking and responsive checks.

## Incremental integration

Access connects the project shell. Manual Studio (Stage 03.2, extended in 03.3) renders the open flow in `src/features/studio/ui` as a controlled React Flow canvas or an ordered List, with a toolbox (Add step, Connect), a shape panel, a Flows menu in the editor header and the right panel's Details tab as the one inspector. Every edit (content, connections, drags, deletes) is applied to an optimistic local draft and queued in an outbox until a save sends it as one version-checked `POST D/changes` (see [Studio canvas](#studio-canvas)); the saved draft is re-read after it. Typed inspector text lives in the per-project store's `buffers` until it is acknowledged; conflicts compare saved and typed values. Realtime adds presence, motion and recovery; exchange adds import and export; durable AI adds conversation and proposals in the right panel's AI tab. Scope, selected checks, agreement and requests extend the same panels. A stage verifies its own reachable controls, not only backend functions.

Unavailable future actions are hidden; simulated screens never claim real saved, approved or collaboration state. The final UI pass verifies cross-feature behavior rather than postponing basic accessibility.

## Studio canvas

- **Shapes** are fixed per kind (sizes in `STEP_SIZE`, `contracts/draft-layout.ts`): START thin circle, OUTCOME bold circle (both 120×120), ACTION rectangle (200×88), DECISION diamond (180×140), DATA_STORE cylinder (120×140). Colours are token-based (`--kind-*` in `tokens.css`): START blue, OUTCOME green, ACTION neutral, DECISION violet, DATA_STORE gold. DATA_STORE is a saved fifth kind that behaves like ACTION in graph checks.
- **Shape panel:** five buttons; drag one onto the canvas or click it to create a step of that kind (new steps get a kind-name label, then open inline editing).
- **Inline editing:** double-click, Enter or F2 edits a step's or connection's label in place; Enter, Escape or blur queues it (Shift+Enter adds a line in a step name), sharing one buffer with the inspector's field, and invalid text stays visible with an error. IME composition is respected (WebKit's Enter included).
- **Connections:** every step has four-sided handles (top, right, bottom, left); a connection may start from any handle, and the chosen sides are remembered (`layout.edgeSides`). Delete on a selected connection queues its removal without a dialog; steps keep their confirmation.
- **Control bar** (bottom left, a `role=group`): zoom out/in, undo, redo. Shortcuts: `+`/`=`, `-`, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y, Ctrl/Cmd+S. Double-click zoom is off (double-click edits). Undo and redo cover only unsaved changes; there is no post-save undo.
- **Saving:** every change is optimistic and unsaved until the header's Save button (left of Inspect), the 10-second autosave, or a save-first action succeeds. Save-first runs before Arrange and before flow and project switches, and Create/Duplicate flow. One merged status covers content and positions ("Saved" only after acknowledgement or a recovered receipt). The inspector's Save saves the whole outbox.
- **Save qualification:** the header and autosave send completed edits in the outbox. Unsubmitted inspector text and endpoint choices stay in separate buffers until their form action; they still count for the leave guard. Autosave currently ends undo history along with manual Save. The [03.3 review](stage-03-3-review.md) records these product limitations and the recommendation to retain autosave.
- **Refused save:** the unsaved changes stay on screen. Each item someone else changed underneath is listed with Saved value / Your edit / Before your edit and a Keep theirs choice; then Apply my changes again (fresh guards, anything that no longer applies is listed) or Discard my changes. An unconfirmed save shows Retry, which resends the same request.
- **Arrange** (header button): a dialog picks Top to bottom or Left to right and previews the server layout read-only; Apply saves it only if the flow is unchanged, Cancel leaves everything as it was.
- Reader and archived views keep pan and zoom only. Other people's changes appear after this person's next save, refusal or reload until Stage 04.

## User-visible truth

- “Saved” follows backend acknowledgement or recovered receipt, never motion or a Broadcast ACK.
- Dirty fields/composers and attempted positions survive remote updates and conflicts; late responses clear only their submitted value.
- AI previews are distinct from saved content; values are edited after Apply or regenerated.
- “Baseline vN approved” names immutable included scope; newer draft/exploratory content does not inherit approval.
- Optional draft scenarios are separate from selected acceptance checks.
- Native JSON imports a new unapproved copy; PNG is visual only.
- Shared-submission notice matches actual source/chat/comment permissions.
- Keyboard/list alternatives, IME-safe input, visible focus, narrow layouts and meaningful recovery are part of each stage.

Detailed screens are linked from the [implementation index](../../.codex/docs/implementation/v1.6/README.md).

