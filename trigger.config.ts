import { defineConfig } from "@trigger.dev/sdk";

// Deployment config for the AI worker, read only by the Trigger CLI (never by the web app). The project reference is not a secret;
// the secret key stays in the Trigger environment. A missing reference must stop the build, never silently deploy to an empty project.
const project = process.env.TRIGGER_PROJECT_REF?.trim();
if (!project) throw new Error("TRIGGER_PROJECT_REF is required to build or deploy the AI worker.");

export default defineConfig({
  project,
  dirs: ["./src/trigger"],
  maxDuration: 330, // seconds: above the 300 s run deadline; SQL, not this limit, decides what may still be stored
  retries: { enabledInDev: false, default: { maxAttempts: 3, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 } },
});
