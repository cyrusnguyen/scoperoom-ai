import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../prisma/generated/client.ts";

/**
 * Hosted Supabase signs database certificates with its own root CA. SCOPEROOM_DATABASE_CA_PEM (a public certificate) makes every pooled
 * connection verify against it; the URL's TLS parameters are dropped because pg would otherwise let them replace this setting.
 */
export function poolConfig(connectionString: string, env: Partial<NodeJS.ProcessEnv> = process.env) {
  const ca = env.SCOPEROOM_DATABASE_CA_PEM?.trim() ? env.SCOPEROOM_DATABASE_CA_PEM : undefined;
  if (!ca) return { connectionString };
  const url = new URL(connectionString);
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl", "uselibpqcompat", "sslnegotiation"]) url.searchParams.delete(name);
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}

export async function createDatabase(connectionString = process.env.DATABASE_URL, expectedEnvironmentId = process.env.SCOPEROOM_ENVIRONMENT_ID) {
  if (!connectionString) throw new Error("DATABASE_URL is required for database access.");
  if (!expectedEnvironmentId) throw new Error("SCOPEROOM_ENVIRONMENT_ID is required for database access.");
  // allowExitOnIdle lets scripts and test processes exit; servers keep the pool warm while busy.
  const database = new PrismaClient({ adapter: new PrismaPg({ ...poolConfig(connectionString), allowExitOnIdle: true }) });
  try {
    const identity = await database.environmentIdentity.findUnique({ where: { id: 1 }, select: { environmentId: true } });
    if (identity?.environmentId !== expectedEnvironmentId) throw new Error("Database environment identity does not match this process.");
    return database;
  } catch (error) {
    await database.$disconnect();
    throw error;
  }
}

const cache = globalThis as typeof globalThis & { scoperoomDatabase?: Promise<PrismaClient>; scoperoomWorkerDatabase?: Promise<PrismaClient> };

/** One verified client per server process (surviving dev reloads); a failed start is retried on the next call. */
export function getDatabase(): Promise<PrismaClient> {
  cache.scoperoomDatabase ??= createDatabase().catch((error: unknown) => {
    cache.scoperoomDatabase = undefined;
    throw error;
  });
  return cache.scoperoomDatabase;
}

/**
 * The restricted worker connection (WORKER_DATABASE_URL, role app_worker): it can read runs and call the fenced claim/settle/dispatch
 * functions and nothing else. Worker services use only this, never web identity, cookies or request state.
 */
export function getWorkerDatabase(): Promise<PrismaClient> {
  const url = process.env.WORKER_DATABASE_URL;
  if (!url) return Promise.reject(new Error("WORKER_DATABASE_URL is required for worker database access."));
  cache.scoperoomWorkerDatabase ??= createDatabase(url).catch((error: unknown) => {
    cache.scoperoomWorkerDatabase = undefined;
    throw error;
  });
  return cache.scoperoomWorkerDatabase;
}
