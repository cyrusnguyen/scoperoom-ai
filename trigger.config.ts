import { defineConfig } from "@trigger.dev/sdk";

// Deployment config for the AI worker. The project reference is not a secret; the secret key stays in the Trigger environment.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./src/trigger"],
  maxDuration: 330, // seconds: above the 300 s run deadline; SQL, not this limit, decides what may still be stored
  retries: { enabledInDev: false, default: { maxAttempts: 3, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 } },
});
