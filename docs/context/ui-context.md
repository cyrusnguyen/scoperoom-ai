# UI context

Atlas Projects (`.worktrees/atlas-projects`, decision E30) is the visual and interaction reference; its synthetic data, local storage and simulated AI are never copied. Its palette is the Atlas Outline palette. Bring over UI with the feature that first uses it; a reference screen is not evidence that a feature works.

## Composition

`/app` is one shell: a collapsible Projects sidebar (Owned / Shared / Archived / Invites, about 300 px), a centre editor, and one on-demand right panel (about 360 px, closed by default). Stage 02R ships the panel's Details tab only; AI arrives in Stage 06 and Specs in Stages 07/11. `resolveDock` (`src/features/shell/ui/dock.ts`) docks the right panel first and the sidebar second, never narrowing the editor below min(W, 560); a panel that cannot dock opens as a focus-trapped overlay only if it was opened last. Closed panels reserve no width. There is no second inspector or navigation sidebar.

The shell (`src/features/shell/ui/project-shell.tsx`) lives in the `/app` layout and survives project switches. It holds a per-project in-memory UI store (panel state and unsaved field values); the editor and right panel under it are keyed by project, so a switch unmounts the previous project's UI observation, and a switch with unsaved values asks Stay or Discard. Only presentation preferences (sidebar open, list tab) are kept in sessionStorage. Tokens live in `src/styles/tokens.css`, and no other stylesheet writes a colour literal. [UI foundations](../../.codex/docs/implementation/v1.6/ui/00-interface-foundations.md) owns the component inventory, docking and responsive checks.

## Incremental integration

Access connects the project shell. Manual Studio (Stage 03.2) renders the open flow in `src/features/studio/ui` as a controlled React Flow canvas or an ordered List, with a toolbox (Add step, Connect), a Flows menu in the editor header and the right panel's Details tab as the one inspector; every change is a draft command and the saved draft is re-read after it. Typed inspector text lives in the per-project store's `buffers` until it is acknowledged; conflicts compare saved and typed values. Saved positions and arrangement arrive in 03.3; Realtime adds presence, motion and recovery; exchange adds import and export; durable AI adds conversation and proposals in the right panel's AI tab. Scope, selected checks, agreement and requests extend the same panels. A stage verifies its own reachable controls, not only backend functions.

Unavailable future actions are hidden; simulated screens never claim real saved, approved or collaboration state. The final UI pass verifies cross-feature behavior rather than postponing basic accessibility.

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

