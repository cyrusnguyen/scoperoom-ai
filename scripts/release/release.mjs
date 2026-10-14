// Production release steps for .github/workflows/release.yml (and an operator shell). Prints names, ids and statuses, never values.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const VERCEL = "https://api.vercel.com";

export function releaseSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) throw new Error("The release SHA must be a full 40-character lower-case commit id.");
  return value;
}

/** A release origin is a bare https origin; a local or mistyped value (for example a copied local NEXT_PUBLIC_APP_URL) stops here. */
export function releaseOrigin(name, value) {
  let url;
  try { url = new URL(value ?? ""); } catch { url = null; }
  if (!url || url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new Error(`${name} must be the production site's bare https origin.`);
  return url.origin;
}

/** pg reads sslrootcert from disk: both database URLs point at the CA file the release writes. */
export function withRootCert(url, path) {
  const parsed = new URL(url);
  parsed.searchParams.set("sslrootcert", path);
  return parsed.toString();
}

/** Every edge check as [method, url, expected status]: web health, and 404 for each path the other service owns. */
export function expectations(web, worker) {
  const tasks = ["repair", "cleanup"];
  return [
    ["GET", `${web}/api/health`, 200],
    ...["GET", "POST", "PUT"].map((method) => [method, `${web}/api/inngest`, 404]),
    ...tasks.flatMap((task) => [["GET", `${web}/api/internal/worker/${task}`, 404], ["POST", `${web}/api/internal/worker/${task}`, 404]]),
    ...["/", "/api/health", "/api/projects", "/logo.png"].map((path) => ["GET", `${worker}${path}`, 404]),
    ...tasks.map((task) => ["POST", `${worker}/api/internal/worker/${task}`, 404]),
  ];
}

/** A GitHub Actions mask command; outside Actions it would print the secret itself, so it is empty there. */
export function maskCommand(value, actions = process.env.GITHUB_ACTIONS === "true") {
  return actions ? `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}` : "";
}

export function synced(status, body) {
  return status === 200 && body?.message === "Successfully registered";
}

/** A deploy with a git ref makes the Inngest SDK register in a branch environment named after it. */
export function deploymentProblem(deployment) {
  if (deployment.readyState !== "READY") return `deployment is ${deployment.readyState ?? "unknown"}, not READY`;
  if (deployment.meta?.gitCommitRef) return "deployment carries a git ref; deploy a git archive export";
  return null;
}

function need(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function vercel(method, path, body) {
  const url = `${VERCEL}${path}${path.includes("?") ? "&" : "?"}teamId=${need("VERCEL_ORG_ID")}`;
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${need("VERCEL_TOKEN")}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Vercel ${method} ${path.split("?")[0]} answered ${response.status} ${data?.error?.code ?? ""}`);
  return data;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const commands = {
  /** Runs one command with both database URLs pointing at a CA file, so the URLs never reach GITHUB_ENV or later steps. */
  async db(...command) {
    if (!command.length) throw new Error("Usage: release.mjs db <command...>");
    const path = join(need("RUNNER_TEMP"), "supabase-ca.crt");
    const ca = need("SCOPEROOM_DATABASE_CA_PEM");
    if (!ca.includes("BEGIN CERTIFICATE")) throw new Error("SCOPEROOM_DATABASE_CA_PEM is not a PEM certificate.");
    writeFileSync(path, ca.endsWith("\n") ? ca : `${ca}\n`);
    const env = { ...process.env };
    for (const name of ["SCOPEROOM_BOOTSTRAP_DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
      env[name] = withRootCert(need(name), path);
      const mask = maskCommand(env[name]);
      if (mask) console.log(mask);
    }
    const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", env });
    if (result.status !== 0) throw new Error(`${command.join(" ")} failed (exit ${result.status}).`);
  },
  /** AI_EXECUTION_BINDING on both projects before either deploy (a `vercel deploy -e` value never reached the runtime). */
  async binding() {
    const sha = releaseSha(process.env.RELEASE_SHA);
    for (const project of [need("VERCEL_WORKER_PROJECT"), need("VERCEL_WEB_PROJECT")]) {
      await vercel("POST", `/v10/projects/${project}/env?upsert=true`, { key: "AI_EXECUTION_BINDING", value: sha, type: "encrypted", target: ["production"] });
      console.log(`binding set on ${project}`);
    }
  },
  async deploy(which) {
    if (which !== "worker" && which !== "web") throw new Error("Usage: release.mjs deploy <web|worker>");
    const project = need(which === "worker" ? "VERCEL_WORKER_PROJECT" : "VERCEL_WEB_PROJECT");
    const { id } = await vercel("GET", `/v9/projects/${project}`);
    const result = spawnSync("vercel", ["deploy", "--prod", "--yes", "--token", need("VERCEL_TOKEN")], {
      // The deployment URL is the only stdout line; build progress goes to stderr and stays in the job log.
      cwd: need("RELEASE_DIR"), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, VERCEL_PROJECT_ID: id }, shell: process.platform === "win32",
    });
    const url = result.stdout.trim().split(/\s+/).pop();
    if (result.status !== 0 || !url?.startsWith("https://")) throw new Error(`vercel deploy for ${project} failed (exit ${result.status}).`);
    const deployment = await vercel("GET", `/v13/deployments/${new URL(url).host}`);
    const problem = deploymentProblem(deployment);
    if (problem) throw new Error(`${project}: ${problem}.`);
    console.log(`${project} deployed: ${deployment.id}`);
  },
  /** The integration's sync-on-deploy is off for CLI deploys: register explicitly, retrying a cold start. */
  async sync() {
    const url = `${releaseOrigin("WORKER_URL", process.env.WORKER_URL)}/api/inngest`;
    for (let attempt = 1; attempt <= 5; attempt++) {
      // A network error or a hung cold start is a failed attempt, not the end of the release.
      const response = await fetch(url, { method: "PUT", signal: AbortSignal.timeout(30_000) }).catch((error) => ({ status: error.name, json: () => null }));
      const body = await Promise.resolve(response.json()).catch(() => null);
      if (synced(response.status, body)) return console.log("inngest sync: registered");
      console.log(`inngest sync attempt ${attempt}: ${response.status} ${body?.message ?? ""}`);
      if (attempt < 5) await wait(5_000);
    }
    throw new Error("Inngest did not register the worker.");
  },
  async checks() {
    const failures = [];
    for (const [method, url, expected] of expectations(releaseOrigin("WEB_URL", process.env.WEB_URL), releaseOrigin("WORKER_URL", process.env.WORKER_URL))) {
      const response = await fetch(url, { method, redirect: "manual" });
      const body = expected === 200 ? await response.json().catch(() => null) : null;
      const ok = response.status === expected && (expected !== 200 || body?.status === "ok");
      console.log(`${ok ? "ok  " : "FAIL"} ${method} ${new URL(url).pathname} ${response.status}`);
      if (!ok) failures.push(`${method} ${url}`);
    }
    if (failures.length) throw new Error(`${failures.length} edge check(s) failed.`);
  },
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (!Object.hasOwn(commands, command ?? "")) throw new Error("Usage: release.mjs db <command...> | binding | deploy <web|worker> | sync | checks");
  await commands[command](...args);
}
