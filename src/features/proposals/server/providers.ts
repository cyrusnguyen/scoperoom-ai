import type { ModelGateway, JobDispatcher } from "./ports.ts";
import { createModelGateway } from "./adapters/model.ts";
import { createJobDispatcher, triggerApi } from "./adapters/trigger.ts";

type Env = Partial<NodeJS.ProcessEnv>;
const present = (value: string | undefined): value is string => Boolean(value?.trim());

/**
 * The one composition module: it builds the single model adapter and the single dispatcher from the process environment. Blank means
 * absent. Without a Trigger key there is no dispatcher, so runs stay PENDING (and time out with a refund); without a Google key the
 * worker cannot call a model. The e2e and CI servers get neither key. The environment is a parameter so tests inject their own.
 */
export function jobDispatcher(env: Env = process.env): JobDispatcher | undefined {
  return present(env.TRIGGER_SECRET_KEY) ? createJobDispatcher(triggerApi(env.TRIGGER_SECRET_KEY)) : undefined;
}

export function modelGateway(env: Env = process.env): ModelGateway {
  if (!present(env.GOOGLE_GENERATIVE_AI_API_KEY)) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is required to call a model.");
  return createModelGateway({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
}
