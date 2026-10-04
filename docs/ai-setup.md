# AI runs: setup, worker deploy, maintenance and provider probe

Stage 06.1 implements durable AI admission, execution and inspection. The web app records intent and cancellation; the worker claims model calls, validates whole results and settles runs. PostgreSQL owns deadlines, budgets and fences. AI controls and reviewed Apply arrive in later PRs. Local tests and model probes do not establish hosted worker readiness.

## Environment

| Variable | Read by | Notes |
| --- | --- | --- |
| `AI_MODEL` | Web admission; direct probe | Model id recorded on each run. New admission is `UNAVAILABLE` when absent or invalid. The worker reads the captured model from PostgreSQL. Not a secret. |
| `AI_EXECUTION_BINDING` | Web admission | Opaque Trigger external deployment id, at most 128 printable characters. Set it to the checked SHA used by the deploy workflow. Not a secret. |
| `TRIGGER_SECRET_KEY` | Web dispatch; worker repair and cancel | Environment-scoped runtime credential. Without a dispatcher, runs remain `PENDING` until their SQL deadline; never-claimed reservations refund once. `SCOPEROOM_E2E` disables web dispatch. |
| `TRIGGER_PROJECT_REF` | Worker build and deploy (`trigger.config.ts`) | Nonsecret project reference. The config throws if it is missing. Store it as the GitHub environment variable for deployment. |
| `TRIGGER_ACCESS_TOKEN` | Trusted deploy workflow; explicitly authorized local dev CLI | CLI personal access token held as a GitHub environment secret for deploys or loaded locally for an authorized dev worker. Excluded from task runtime; never an application or PR secret. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Worker; explicitly authorized direct probe | Model credential. Configure it in the intended Trigger environment, never the browser, Vercel web build or PR jobs. |
| `WORKER_DATABASE_URL` | Worker | Restricted `app_worker_runtime` login. Never a bootstrap or migrator credential. |
| `SCOPEROOM_ENVIRONMENT_ID` | Web and worker | Must equal the database environment identity. Worker cleanup also checks it inside SQL. |

The template `.env.example` supplies empty placeholders for these values. Managed e2e servers blank provider secrets, including the CLI token; automated worker tests inject fake ports. PR jobs receive no hosted provider keys.

Configure worker runtime values in the intended Trigger project/environment: `WORKER_DATABASE_URL`, `SCOPEROOM_ENVIRONMENT_ID` and `GOOGLE_GENERATIVE_AI_API_KEY`. Trigger supplies its runtime `TRIGGER_SECRET_KEY`; verify that behavior in the intended account before hosting. Bootstrap/migration credentials belong only to protected operator or isolated CI commands.

## Worker deployment

`.github/workflows/deploy-worker.yml` is the single worker deployment owner. It is manual (`workflow_dispatch`) and accepts only `worker-synthetic`, a dedicated synthetic project's production environment. Keep pilot configuration in a separate project; this workflow does not authorize a pilot deployment.

- Start the workflow from `main`. Its full lowercase `sha` must be an ancestor of `main`.
- It queries the actual `ci.yml` workflow for that exact SHA's latest `push` run on `main`, requires that run to succeed, then requires `static-unit-build`, `database-integration` and `chromium` each to succeed in its latest attempt. A similarly named check or earlier successful attempt cannot satisfy the gate. These queries use GitHub's [workflow-run](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow) and [workflow-job](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt) APIs with `actions: read`.
- The `worker-synthetic` GitHub environment holds `TRIGGER_ACCESS_TOKEN` as a secret and `TRIGGER_PROJECT_REF` as a variable. Configure required reviewers where the account supports them; their availability and enforcement remain unverified.
- Workflow concurrency allows one worker deploy at a time and never cancels one already started.
- The exact-pinned CLI deploys the checked commit with `trigger deploy --env prod --external-id <sha> --skip-update-check --skip-telemetry`. The execution binding always equals that SHA; arbitrary reusable release tags are not accepted.
- The summary records target, SHA/external id, provider-returned deployment version and required CI run.

Trigger's [external deployment identity](https://trigger.dev/docs/deployment/atomic-deployment) pins a run to the deployment carrying that identity. The adapter passes each run's captured binding as `externalDeploymentId`, including repaired dispatches. A missing deployment may wait up to one hour in Trigger, while the application's 300-second SQL deadline remains authoritative. The web build never resolves Trigger metadata.

The same external id short-circuits an already completed deploy. Changed environment configuration can therefore leave the previous image in place when redeploying the same SHA. Treat configuration changes as a new reviewed release with a new SHA and recorded configuration revision; do not silently reuse the binding for different inputs. Trigger documents this behavior under [reusing an id and changed build inputs](https://trigger.dev/docs/deployment/atomic-deployment#reusing-an-id).

Before any authorized hosted release:

1. Confirm the intended synthetic project/environment, compatible migration head, runtime role and environment identity. Apply compatible migrations with the protected migration credential before the worker, following [the release procedure](../.codex/docs/implementation/v1.6/delivery/03-ci-cd-and-release.md).
2. Disable Trigger's GitHub and Vercel auto-deploy integrations, so this workflow owns worker deployment. Vercel continues to own web builds.
3. Configure the GitHub environment, its credential, project reference and supported approval protection.
4. Run the approved deployment for the checked SHA. Set the matching web build's `AI_EXECUTION_BINDING` to that SHA. Record web/worker identities, target, configuration revision and migration head.
5. Qualify the exact deployed binding and one maintenance schedule using bounded synthetic runs before claiming hosted readiness.

The workflow has not run. Account changes and deployment require explicit session authorization.

### Incompatible worker change

Follow [Data 04](../.codex/docs/implementation/v1.6/data/04-jobs-and-provenance.md) and [provider replacement](../.codex/docs/implementation/v1.6/data/05-provider-boundaries.md):

1. Pause new AI admission by unsetting `AI_MODEL` in the web environment and redeploying it. Existing receipt recovery and graph editing remain available.
2. Finish or terminally settle old runs under their captured binding. Confirm no `app.ai_run` remains `QUEUED`, `RUNNING` or `VALIDATING`; the SQL deadline is at most 300 seconds from admission. Do not replay uncertain calls on a different worker/provider.
3. Apply compatible migrations and deploy the upgraded worker through the maintenance window under the new checked SHA. Configure the new `AI_MODEL` and matching `AI_EXECUTION_BINDING` for the web build.
4. Resume admission. Retire old deployments only once their admitted runs are terminal.

Compatible updates preserve the task envelope and availability of handlers for runs admitted under prior bindings.

## Maintenance and retention

`src/trigger/repair-runs.ts` declares one scheduled task, `repair-runs`, at `* * * * *` (target 60 seconds). Hosted cadence, eligibility and uniqueness per intended environment remain unverified. Each tick calls `runMaintenance`; both bounded steps run even if one fails, then the first failure is reported:

1. `repairRuns` settles overdue runs, handles cancellation intent and re-delivers pending dispatches under the original dispatch id and execution binding. Never-claimed reservations refund once; possibly started calls stay consumed against their original owner and admission day.
2. `workerCleanup` sweeps up to 100 eligible rows per transient category, including AI bodies, through `app.run_worker_cleanup(environment id, batch)`.

SQL validates the environment identity and batch bound for worker cleanup. The worker cannot execute raw cleanup functions or directly update retained bodies/receipts. The [local operator command](maintenance.md) keeps its loopback and bootstrap-credential guard; bootstrap credentials are never deployed. Tick logs contain schedule time, lag and counts, with no prompt or result body. SQL deadlines still apply when delivery is late or duplicated.

Retention applies from the first persisted run: unneeded terminal capture/result bodies expire after seven days, with applied evidence preserved; unused `AVAILABLE` results become `EXPIRED`. Run identity, hashes, attribution, usage, prompt and cited source versions survive. Improve history stores its immutable selected flow id separately from the expiring capture, including after that flow is deleted. Migration backfills only retained captures; already purged captures cannot reconstruct a missing flow id. Receipts, including the start manifest, live 30 days. Late output cannot restore purged bodies. PR 2 owns permanent application evidence and its first consumer.

If a worker exits during result validation, its current attempt remains busy until settled or its attempt window expires. Recovery marks an abandoned attempt `UNKNOWN` and requires a fresh second token/pointer within the original deadline; late output from the first attempt stays fenced. A run that used both attempts settles without a third model call. The recovery migration preserves the original owner/day charge. Pre-call input rejection rechecks cancellation, the SQL deadline and current authority after all blocking locks before terminal settlement, refunds an unused reservation once and makes no model call.

A Trigger retry that encounters a busy attempt keeps its delivery alive with `wait.until` at the SQL attempt deadline, capped by the original run deadline. It then re-enters the same claim service. Validation and recovery state changes advance `aiRevision` atomically; duplicate deliveries do not add a state event. Run reads derive seven-day applicability expiry from the SQL snapshot clock even when cleanup has not removed the body yet.

## Direct model probe

`scripts/ai/probe.mts` sends only fixed synthetic inputs through the production ModelGateway. It is excluded from CI and refuses without `--live`. `--only` accepts unique names from `generate`, `improve`, `unsupported-schema`, `calibrate-ascii-40k` and `calibrate-cjk-10k`; unknown, duplicate or empty selections fail before any call.

```powershell
node --env-file-if-exists=.env.local --experimental-strip-types scripts/ai/probe.mts --live --only=generate,improve,unsupported-schema
```

Run only with explicit authorization and a cumulative call budget for that session. There are at most five calls per invocation, no SDK retries. Multiple invocations still spend additional quota; the per-invocation guard does not enforce the session budget. Calls are paced by `PROBE_PACE_MS` (default 13,000 ms); actual rate limits depend on the configured account/model.

Generate and Improve must complete, pass whole-result validation and return known normalized usage to qualify. The unsupported case expects the adapter's `refused` outcome, which does not by itself prove a particular HTTP status or failure cause. Calibration cases require a completed response with known usage. The summary marks each expectation and exits nonzero if any selected case is unverified.

Calibration uses synthetic ASCII prose and dense non-ASCII text. This trusted harness overrides the local estimated input guard to 1,000,000 tokens for those two calls so provider usage can be measured; it does not demonstrate enforcement of the production 16,000 input-token ceiling. The 6,000 output ceiling and timeouts remain in force. Production admission/worker limits are unchanged.

Output is restricted to model/package identifiers, normalized outcome and usage, schema acceptance, verification, latency, byte estimates and ceiling information. Secret-free JSON stays under ignored `.tmp/stage-06.1/probe/`; no keys, prompts, provider request ids or raw output are printed or saved.

### Inherited probe evidence (2026-10-03)

Four existing safe summaries record 16 calls using `gemini-3.8-flash`, `ai` 7.0.127 and `@ai-sdk/google` 4.0.87. That exceeded the requested approximately six-call session budget. This was the inherited checkpoint before the separately authorized renewed session below.

- Improve completed once and passed `validateResult`: 1,497 input tokens, 954 output tokens, 6,253 ms. Its local estimate was 1,694 tokens for 5,081 bytes, about 13 percent above the reported count.
- Both unsupported-schema entries normalized to `refused`. The summaries contain no HTTP status or cause, so a provider schema-specific rejection is not proved.
- Initial Generate/Improve entries normalized to `refused`; after the wire-schema change removing `maxItems`, Improve passed. The summaries do not establish that keyword as the cause of every earlier refusal.
- Generate and both calibration inputs have no completed result or real input count. Later entries normalized to `unavailable`, which does not distinguish rate limits, timeouts or server errors.
- The input estimate remains three UTF-8 bytes per token. One small Improve result is insufficient to calibrate large ASCII/non-ASCII inputs or prove accurate ceiling enforcement. Further calibration requires renewed authorization and reliable model access.

The historical probe had no failing exit for unverified expectations; its process exit is not a qualification result. The new guard/verification behavior has only no-network regression coverage so far.

## Unverified hosted qualifications

Trigger dev dispatch and duplicate delivery completed in the renewed session below. Production external-id binding, delayed delivery, schedule cadence and jitter are **NOT RUN**. Dev completion with the binding option present does not establish deployment pinning. No deployment, login or account change occurred.

Auto-deploy ownership, GitHub environment protection, intended project/runtime configuration and schedule eligibility need operator qualification. The top-up session below measured large-input token usage and accepted model requests. A whole-valid Generate proposal and a nonempty Improve edit proposal remain unqualified. The renewed invalid-schema case established an HTTP 400 schema rejection. These limitations must stay separate from passing deterministic/local gates.

Deletion accounting and lock safety: deleting a run releases its original owner/day reservation only when no dispatch or call could have started. A leased or acknowledged dispatch remains charged conservatively; already consumed usage is retained. Repeat deletion and late task delivery cannot recreate the run or refund twice. Background body cleanup skips locked projects and rows, leaving them for a later tick. Worker cleanup arms a five-second SQL statement timeout before the sweep starts; the transaction-local setting does not leak to the pool.

### Renewed qualification evidence (2026-10-04)

A further bounded synthetic session authenticated both existing provider credentials without displaying their values. Google model metadata returned HTTP 200 and listed `gemini-3.8-flash`. Generate and Improve requests using that model each returned HTTP 503, normalized to `unavailable`; neither supplied a completed result or usage. The intentionally invalid schema returned HTTP 400 with a schema-request rejection, normalized to `refused`. This confirms the negative schema case through the production ModelGateway.

A 40,000-character synthetic ASCII Generate request estimated 15,409 input tokens and passed the configured 16,000-token local guard. Google listed `gemini-2.5-flash`, but its generation endpoint returned HTTP 404. That call does not qualify the model or calibrate the estimate. No new completed Generate or large-input usage evidence is claimed.

Trigger's dev metadata endpoint returned HTTP 200. Initial project discovery returned HTTP 401 with the development environment key; the pinned CLI needed the existing project reference and a personal access token. Once the user supplied those locally, the project identity authenticated with HTTP 200 and the provided runtime key was confirmed to belong to the same dev environment. An isolated local worker started through the pinned public CLI without login, deployment or account changes. Only unique synthetic probe task IDs were registered; production AI and maintenance tasks were excluded.

Two control runs completed, both without and with `externalDeploymentId` set. Repeating each dispatch with its original idempotency key returned the same provider run ID. The Windows dev CLI could not create a dependency directory symlink (`EPERM`); a junction inside the ignored probe directory enabled indexing. No repository dependency or production config change was needed.

The sixth and final authorized model call used `gemini-3.8-flash` through the production dispatcher, ModelGateway and `runAi`, with the task ID mapped to a unique probe ID for isolation. The worker used only `app_worker` on the guarded loopback database and validated its environment identity. The synthetic source contained 40,000 ASCII characters, estimated at 14,776 input tokens against the 16,000 ceiling. Google returned HTTP 503, normalized to `unavailable`, in a 2,480 ms worker run; no result or usage was returned. The session guard blocked a second HTTP request after the sixth call, so the retry attempt settled as `UNKNOWN` and the run ended `FAILED` with `MODEL_UNKNOWN`. This qualifies failure settlement under the probe budget, not an unrestricted two-call provider retry.

A forced second delivery with a new provider idempotency key completed with zero gateway invocations and zero model HTTP requests. SQL inspection confirmed `DISPATCHED`, two settled attempts, no stored result, zero reserved runs and one consumed run charged to the original owner/day. The isolated worker was stopped and only its recorded local fixtures were removed.

All six renewed calls are consumed. A preceding small schema control returned HTTP 429, confirming a quota or rate rejection at that time; the later HTTP 503 does not identify a quota bucket or establish its cause. At that checkpoint no additional model call was authorized, and Generate completion, new Improve completion and large-input usage calibration were unverified. The separately authorized top-up session below adds later evidence; the input estimate remains unchanged. Production binding and scheduled cadence/jitter still require separate deployment qualification.

### Top-up qualification evidence (2026-10-04)

After the user topped up Google quota, a separate session allowed exactly two synthetic model HTTP requests, one per case. The original six-call ledger remains unchanged. The per-case guard blocked automatic repeat requests and all provider SDK retries remained disabled.

- Generate used a fresh 40,000-character ASCII fixture through the production dispatcher, ModelGateway and `runAi` on the restricted local worker. Google returned HTTP 200 with 8,009 input tokens and 1,116 output tokens. The estimated input was 14,798 tokens for 44,394 request bytes, 1.85 times reported usage; both counts were below 16,000. The reply failed whole-result validation, so SQL settled one `INCOMPLETE` attempt, ended the run `FAILED` with `RESULT_INVALID`, stored no result and charged one original owner/day reservation. The harness retained no raw reply or exact validation reason, so this is successful provider transport and usage measurement, not a validated Generate proposal.
- Improve used 10,000 synthetic CJK code points through the production ModelGateway and whole-result validator. Google returned HTTP 200 with 7,268 input tokens and 2,891 output tokens. The result was a valid clarification. The estimate was 11,706 tokens for 35,116 request bytes, 1.61 times reported input usage; both counts were below 16,000. This qualifies the Improve clarification path, not a nonempty edit proposal.

The measured cases support retaining the conservative three-bytes-per-token estimate: both accepted inputs passed its 16,000-token guard and their reported usage stayed below the ceiling. They do not prove tokenizer accuracy for every source or model, so no broader ceiling guarantee or unmeasured calibration claim is made.

Trigger dispatch completed, repeating the original key returned the same provider run ID, and a forced duplicate made zero gateway or model HTTP calls. SQL confirmed `DISPATCHED`, no stored invalid content and zero reserved/one consumed run. The isolated worker was stopped and only its recorded fixture was cleaned. The new ledger is exhausted at two of two. No deployment, login or account change occurred.
