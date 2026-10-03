// Immutable evidence limits (Data 01 "Evidence budgets and immutable origin"). Stage 06 consumes the per-version text bound; the
// retained-version, project and document capacities arrive with the writer that enforces them under the project lock.
export const SOURCE_LIMITS = { submissionCodePoints: 50_000 } as const;
