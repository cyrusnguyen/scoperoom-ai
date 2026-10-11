import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLocalContainer, localConfig } from "./guard.mjs";

export function resetLocal(env = process.env) {
  const configPath = resolve(env.SCOPEROOM_SUPABASE_CONFIG ?? fileURLToPath(new URL("../../supabase/config.toml", import.meta.url)));
  const canonical = realpathSync(configPath);
  const samePath = process.platform === "win32" ? configPath.toLowerCase() === canonical.toLowerCase() : configPath === canonical;
  if (!samePath || basename(canonical) !== "config.toml" || basename(dirname(canonical)) !== "supabase") {
    throw new Error("Database reset needs an unlinked <workdir>/supabase/config.toml target.");
  }
  const workdir = dirname(dirname(canonical));
  const { projectId, dbPort } = localConfig(canonical);
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId) || !/^\d+$/.test(dbPort) || Number(dbPort) < 1 || Number(dbPort) > 65535) {
    throw new Error("Database reset rejected invalid local Supabase project configuration.");
  }
  const childEnv = { ...env, SCOPEROOM_SUPABASE_CONFIG: canonical, SUPABASE_PROJECT_ID: projectId, SUPABASE_DB_PORT: dbPort, SUPABASE_WORKDIR: workdir };
  delete childEnv.SUPABASE_CLI_BINARY_OVERRIDE;
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  function run(args, commandEnv = childEnv) {
    const result = spawnSync(process.execPath, args, { stdio: "inherit", env: commandEnv, shell: false, cwd: sourceRoot });
    if (result.status !== 0) {
      const error = new Error("Database reset stopped after a failed command.");
      error.exitCode = result.status ?? 1;
      throw error;
    }
  }
  const currentEnvironmentId = env.SCOPEROOM_CURRENT_ENVIRONMENT_ID ?? env.SCOPEROOM_ENVIRONMENT_ID;
  run([fileURLToPath(new URL("./guard.mjs", import.meta.url))], { ...childEnv, SCOPEROOM_ENVIRONMENT_ID: currentEnvironmentId });
  const { container, loopbackNetworks } = inspectLocalContainer(projectId, dbPort);
  if (Object.keys(container.NetworkSettings?.Networks ?? {}).length !== 1 || loopbackNetworks.length !== 1) {
    throw new Error("Database reset rejected an ambiguous local Supabase network.");
  }
  // Reuse the verified network so the recreated database stays loopback-only and reachable by its services.
  const cli = createRequire(import.meta.url).resolve("supabase/dist/supabase.js");
  run([cli, "db", "reset", "--local", "--workdir", workdir, "--network-id", loopbackNetworks[0]]);
  run([fileURLToPath(new URL("./bootstrap.mjs", import.meta.url))]);
}

if (import.meta.main) {
  try {
    resetLocal();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
