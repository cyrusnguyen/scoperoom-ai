/** Returns why a database's Prisma history cannot be migrated from this repository, or null when it can. */
export function historyProblem(historySchema, appliedNames, localNames) {
  if (historySchema === "public") return "This database still uses the pre-baseline public migration history. Reset it before migrating.";
  const unknown = appliedNames.filter((name) => !localNames.includes(name));
  if (unknown.length) return `This database predates the project baseline (${unknown.join(", ")}). Reset required.`;
  return null;
}
