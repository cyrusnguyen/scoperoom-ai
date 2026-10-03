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
let dispatcher: { key: string; value: JobDispatcher } | undefined;
let gateway: { key: string; value: ModelGateway } | undefined;

export function jobDispatcher(env: Env = process.env): JobDispatcher | undefined {
  const key = env.TRIGGER_SECRET_KEY;
  if (!present(key)) return undefined;
  if (dispatcher?.key !== key) dispatcher = { key, value: createJobDispatcher(triggerApi(key)) };
  return dispatcher.value;
}

export function modelGateway(env: Env = process.env): ModelGateway {
  const key = env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!present(key)) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is required to call a model.");
  if (gateway?.key !== key) gateway = { key, value: createModelGateway({ apiKey: key }) };
  return gateway.value;
}
