import { NonRetriableError } from "inngest";
import type { JobRequest } from "./ports.ts";
import { modelGateway } from "./providers.ts";
import { runAi } from "./run-ai.ts";

export const MAX_DELIVERY_ROUNDS = 4;
export type DeliveryStep = { run(id: string, fn: () => Promise<string | null>): Promise<string | null>; sleepUntil(id: string, at: string): Promise<void> };

/**
 * The `run-ai` function body. Only the build whose AI_EXECUTION_BINDING equals the run's binding may execute it. Each round is one
 * `step.run` (one Vercel invocation, under the 300 s limit; Inngest retries it if it crashes); a BUSY claim sleeps durably until the
 * SQL-owned window ends. Rounds are bounded; SQL grants every model call and the deadline settles anything left.
 */
export async function deliverRun(data: JobRequest, step: DeliveryStep, { binding = process.env.AI_EXECUTION_BINDING, execute = (runId: string) => runAi(runId, modelGateway()) }: { binding?: string; execute?: (runId: string) => Promise<Date | void> } = {}): Promise<void> {
  if (!binding || data.executionBinding !== binding) throw new NonRetriableError("This worker build is not the run's execution binding.");
  for (let round = 1; round <= MAX_DELIVERY_ROUNDS; round += 1) {
    const retryAt = await step.run(`attempt-${round}`, async () => (await execute(data.runId))?.toISOString() ?? null);
    if (!retryAt) return;
    await step.sleepUntil(`busy-${round}`, retryAt);
  }
}
