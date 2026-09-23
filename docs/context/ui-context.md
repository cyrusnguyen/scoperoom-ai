# UI context

The selected Atlas Outline design remains preserved in `.worktrees/atlas-outline` as reference. The active Stage 01 app is a small truthful shell. Bring over UI components only with the feature that first uses them; do not infer completed functionality from a reference screen.

## Composition

Use one workspace: compact top navigation, AI conversation on the left, canvas/list or focused content in the center, and one shared contextual right panel. The panel shows project details when appropriate and switches to node/edge/scope/source/review context. It remains collapsible; there is no second permanent inspector or chat panel.

Use the reference tokens and components when their features become functional. Add accessible controls and states with their first consumer. Correct concrete contrast, keyboard and layout issues in the active UI. [UI foundations](../../.codex/docs/implementation/v1.5/ui/00-interface-foundations.md) owns the component inventory and responsive checks.

## Incremental integration

Access connects the project shell, manual Studio connects toolbox/forms and saved positions, Realtime adds presence/motion/recovery, exchange adds import/export, then durable AI connects conversation/proposals. Scope, selected checks, agreement and requests extend the same panels. A stage verifies its own reachable controls, not only backend functions.

Unavailable future actions are hidden or clearly unavailable; simulated screens never claim real saved/approved/collaboration state. The final UI pass verifies cross-feature behavior rather than postponing basic accessibility.

## User-visible truth

- “Saved” follows backend acknowledgement or recovered receipt, never motion or a Broadcast ACK.
- Dirty fields/composers and attempted positions survive remote updates and conflicts; late responses clear only their submitted value.
- AI previews are distinct from saved content; values are edited after Apply or regenerated.
- “Baseline vN approved” names immutable included scope; newer draft/exploratory content does not inherit approval.
- Optional draft scenarios are separate from selected acceptance checks.
- Native JSON imports a new unapproved copy; PNG is visual only.
- Shared-submission notice matches actual source/chat/comment permissions.
- Keyboard/list alternatives, IME-safe input, visible focus, narrow layouts and meaningful recovery are part of each stage.

Detailed screens are linked from the [implementation index](../../.codex/docs/implementation/v1.5/README.md).

