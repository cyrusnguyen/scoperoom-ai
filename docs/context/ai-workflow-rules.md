# Codex workflow rules

These govern development work. Product AI behavior belongs to the implementation handbook.

## Start and scope

Read root instructions, tracker and relevant context/stage/contracts. Inspect actual source/package scripts/repository state before assuming previous work exists. Current user authorization overrides historical task notes; do not repeat permission questions for already authorized work.

Complete one reviewable checkpoint with its UI, data path and relevant failure tests. Keep related work together across layers. Independent agents may own bounded files/tasks when the session supports delegation; reconcile shared contracts before claiming completion.

The primary session remains the lead/integrator. Use the project-scoped roles selectively rather than launching a permanent team. Keep one active writer per path or working tree, provide explicit ownership and acceptance criteria, and give reviewers/verifiers a stable change to inspect.

## Decisions and boundaries

Record meaningful authorized changes in the existing decision register and owning contracts, then update summaries. Preserve existing UI and unrelated changes. Locate the intended UI source before integration if the active checkout differs.

Resolve routine choices within scope; ask only for missing information that materially changes behavior/access/cost or genuinely requires authorization, while continuing independent work. Do not turn historical frozen wording into a prohibition on explicitly requested corrections.

Use the current session's skills/tools. A plan alone does not authorize cloud provisioning, purchases, publication, messages, destructive cleanup, commits or pushes. Planned or mocked tests are not actual-provider evidence.

Lead, verifier and reviewer follow fix-forward review. A confirmed bug, regression, inadequate test or faulty design within the authorized change is both raised and repaired in the same branch/change set without waiting for another assignment; add focused coverage and rerun affected checks. Coordinate before touching an active writer's paths. New product decisions, unrelated work, destructive actions and external mutations remain outside this standing authorization.

## Completion and handoff

1. Verify the requested behavior and meaningful failure/recovery cases at the owning layer.
2. Run implemented checks appropriate to the change; documentation work needs content/link/consistency checks, not a speculative application build.
3. Resolve contract inconsistencies and update affected owners within authorized scope.
4. Record actual stage/checkpoint status, evidence, limitations and next action in the tracker.
5. Summarize completed changes and practical limits without declaring future gates passed.

Keep the tracker concise rather than accumulating a transcript. Store no credentials, raw private context or provider payloads. After compaction, reconcile tracker, latest request and actual state; resume unfinished work rather than restart.
