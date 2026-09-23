# ScopeRoom AI documentation

1. [Context index](context/README.md) and [tracker](context/progress-tracker.md): orientation, observed state and next checkpoint.
2. [v1.5 implementation plan](implementation/v1.5/README.md): the single active fourteen-stage plan.
3. [Corrected specification](implementation/v1.5/PROJECT-SPEC.md) and [decisions/acceptance coverage](implementation/v1.5/01-requirements-and-decisions.md): product authority and explicit implementation choices.
4. Relevant data/API/UI/delivery contracts linked from that plan: exact behavior and verification gates.

The handbook adopts PostgreSQL saved content/positions, Supabase Realtime collaboration and immutable approval that preserves newer draft edits. It builds on the existing ScopeRoom interface through staged functional integration.

Completed planning reviews are consolidated in these owners; there is no separate review/correction plan to replay. Future evidence belongs in `docs/evidence/<stage-or-release>/` only after checks run, following the [stage-exit protocol](implementation/v1.5/delivery/02-testing-and-evaluation.md#stage-exit-evidence).

Vercel handles web deployments; GitHub checks gate production. [Release](implementation/v1.5/delivery/03-ci-cd-and-release.md), [operations](implementation/v1.5/delivery/05-operations-and-recovery.md) and [logging](implementation/v1.5/delivery/07-logging-and-observability.md) define the required evidence. Documentation readiness does not certify an untested application.

