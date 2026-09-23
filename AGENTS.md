# ScopeRoom AI — Codex instructions

## Start and resume

Read [the context index](docs/context/README.md) and [progress tracker](docs/context/progress-tracker.md), then relevant context and detailed contracts. On a first implementation session read all six short context files. After a handoff or compaction reread the tracker and current task. The archived stage plan is reference material.

The current user request determines authorized work. Historical documentation-only notes are not a permanent prohibition on later implementation. Continue authorized work without repeating permission questions.

## Project rules

- Preserve the Atlas Outline source worktree and unrelated user changes. Add active UI only with its stage; visible screens do not prove their backend works.
- The v1.5 planning material under `.codex/docs/implementation/v1.5` is archived reference. The current user request and [progress tracker](docs/context/progress-tracker.md) define active stage scope. Record authorized changes and actual evidence there.
- Implement one small reviewable stage at a time. Stage 01 is only a shell and database foundation; later stages add feature UI, data and recovery with their first consumer.
- PostgreSQL owns saved content, node positions and authority. Supabase Realtime carries presence and advisory previews/hints. AI proposes changes for human review.
- Preserve current authorization, scoped receipts, targeted version checks and transaction boundaries. Normal publication keeps the current draft and newer work.
- Inspect package.json and the lockfile before commands. Planned pnpm migration and tests are not assumed current capabilities.
- Keep feature UI beside its feature, shared browser helpers in src/client, trusted infrastructure in src/server and tooling at root. Enforce import boundaries, not only folder names.
- Update [progress-tracker.md](docs/context/progress-tracker.md) at durable checkpoints/handoffs with actual evidence, limitations and next action. Keep plans, implementation and verification distinct.
- Follow available session skills/tool instructions. When /graphify is explicitly requested, read/use the installed graphify skill first.

## Agent team

The primary session is the lead/integrator. It owns requirements, scope, shared interfaces, task assignment, integration and final verification; do not spawn a second coordinator. Use the project-scoped `repo_scout`, `implementer`, `verifier` and `reviewer` roles when they reduce uncertainty or provide independent evidence. Use `designer`, `investigator` and `security_auditor` only when their specialist scope is relevant. Small, clear tasks should stay with the lead.

Keep one active writer per path or working tree. Settle shared contracts before parallel work, give each child an explicit objective, source of truth, owned paths, verification requirements and stop conditions, and review actual evidence rather than summaries. Test and review a stable change, then rerun meaningful checks after integration.

The lead, verifier and reviewer use a fix-forward policy: when they confirm an in-scope bug, regression, inadequate test or faulty design in the current change, they must report it and fix it in the same branch/change set without waiting for another delegation. They add or update focused regression coverage and rerun affected checks. This standing instruction does not authorize unrelated refactors, concurrent edits to another writer's paths, destructive actions, external mutations, or product decisions beyond the current request; those still require coordination or user authority.

Workflow and handoff: [ai-workflow-rules.md](docs/context/ai-workflow-rules.md).
