import { readProcessEnv } from "./server/env.ts";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") readProcessEnv();
}
