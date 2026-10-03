// Immutable evidence limits (Data 01 "Evidence budgets and immutable origin"). Every retained version, archived and internal prompts
// included, counts against the project-wide capacity; AI_PROMPT bypasses only the 30 active user-managed-document cap, which has no
// consumer yet. The writer enforces these under the project lock.
export const SOURCE_LIMITS = { submissionCodePoints: 50_000, retainedVersions: 500, projectCodePoints: 500_000 } as const;
