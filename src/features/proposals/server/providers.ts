import type { ModelGateway, JobDispatcher } from "./ports.ts";
import { createModelGateway } from "./adapters/model.ts";
import { Inngest } from "inngest";
import { createJobDispatcher, INNGEST_APP_ID } from "./adapters/inngest.ts";

type Env = Partial<NodeJS.ProcessEnv>;
const present = (value: string | undefined): value is string => Boolean(value?.trim());

/**
 * The one composition module: it builds the single model adapter and the single dispatcher from the process environment. Blank means
 * absent. Without an Inngest event key there is no dispatcher, so runs stay PENDING (and time out with a refund); a worker calls only the
 * providers whose keys it holds (Google, Anthropic), and a run for another provider fails before its claim. The e2e and CI servers get neither key. The environment is a parameter so tests inject their own.
 */
let dispatcher: { key: string; value: JobDispatcher } | undefined;
let gateway: { key: string; value: ModelGateway } | undefined;

export function jobDispatcher(env: Env = process.env): JobDispatcher | undefined {
  const key = env.INNGEST_EVENT_KEY;
  // A test server (SCOPEROOM_E2E, as the docs require for a hand-started one) never dispatches, even if Next loaded a real key from .env.local.
  if (!present(key) || present(env.SCOPEROOM_E2E)) return undefined;
  if (dispatcher?.key !== key) dispatcher = { key, value: createJobDispatcher(new Inngest({ id: INNGEST_APP_ID, eventKey: key })) };
  return dispatcher.value;
}

export function modelGateway(env: Env = process.env): ModelGateway {
  const google = present(env.GOOGLE_GENERATIVE_AI_API_KEY) ? env.GOOGLE_GENERATIVE_AI_API_KEY : undefined;
  const anthropic = present(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY : undefined;
  if (!google && !anthropic) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY or ANTHROPIC_API_KEY is required to call a model.");
  const key = JSON.stringify([google, anthropic]);
  if (gateway?.key !== key) gateway = { key, value: createModelGateway({ apiKey: google, anthropicApiKey: anthropic }) };
  return gateway.value;
}
