// Provider secrets that automated suites must never hand to a server they start. Next.js loads .env.local on its own and never
// overrides a variable that is already defined, so the names are blanked (not deleted); the composition module treats blank as absent.
export const PROVIDER_SECRET_NAMES = ["GOOGLE_GENERATIVE_AI_API_KEY", "TRIGGER_SECRET_KEY", "TRIGGER_ACCESS_TOKEN"];

export function withoutProviderSecrets(env) {
  return { ...env, ...Object.fromEntries(PROVIDER_SECRET_NAMES.map((name) => [name, ""])) };
}
