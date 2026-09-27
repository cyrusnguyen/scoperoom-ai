# ScopeRoom AI documentation

1. [Context index](context/README.md) and [tracker](context/progress-tracker.md): orientation, observed state and next checkpoint.
2. [v1.6 implementation plan](../.codex/docs/implementation/v1.6/README.md): current staged handbook (v1.5 is superseded and kept locally for history only); the current request and tracker set active scope.
3. [Corrected specification](../.codex/docs/implementation/v1.6/PROJECT-SPEC.md) and [decisions/acceptance coverage](../.codex/docs/implementation/v1.6/01-requirements-and-decisions.md): product authority and explicit implementation choices.
4. Relevant data/API/UI/delivery contracts linked from that plan: exact behavior and verification gates.
5. [Supabase email signup setup](auth-setup.md): local code delivery and hosted Auth requirements.

The handbook adopts PostgreSQL saved content/positions, Supabase Realtime collaboration and immutable approval that preserves newer draft edits. It builds on the existing ScopeRoom interface through staged functional integration.

Completed planning reviews are consolidated in these owners; there is no separate review/correction plan to replay. Future evidence belongs in `docs/evidence/<stage-or-release>/` only after checks run, following the [stage-exit protocol](../.codex/docs/implementation/v1.6/delivery/02-testing-and-evaluation.md#stage-exit-evidence).

Vercel handles web deployments; GitHub checks gate production. [Release](../.codex/docs/implementation/v1.6/delivery/03-ci-cd-and-release.md), [operations](../.codex/docs/implementation/v1.6/delivery/05-operations-and-recovery.md) and [logging](../.codex/docs/implementation/v1.6/delivery/07-logging-and-observability.md) define the required evidence. Documentation readiness does not certify an untested application.

