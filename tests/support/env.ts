/** True when every variable is set. Under CI a missing variable is an error, so database suites cannot silently skip. */
export function requireEnv(names: string[]): boolean {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length && process.env.CI === "true") throw new Error(`CI is missing required test environment: ${missing.join(", ")}`);
  return missing.length === 0;
}
