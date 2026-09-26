import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../prisma/generated/client.ts";

export async function createDatabase(connectionString = process.env.DATABASE_URL, expectedEnvironmentId = process.env.SCOPEROOM_ENVIRONMENT_ID) {
  if (!connectionString) throw new Error("DATABASE_URL is required for database access.");
  if (!expectedEnvironmentId) throw new Error("SCOPEROOM_ENVIRONMENT_ID is required for database access.");
  // allowExitOnIdle lets scripts and test processes exit; servers keep the pool warm while busy.
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString, allowExitOnIdle: true }) });
  try {
    const identity = await database.environmentIdentity.findUnique({ where: { id: 1 }, select: { environmentId: true } });
    if (identity?.environmentId !== expectedEnvironmentId) throw new Error("Database environment identity does not match this process.");
    return database;
  } catch (error) {
    await database.$disconnect();
    throw error;
  }
}

const cache = globalThis as typeof globalThis & { scoperoomDatabase?: Promise<PrismaClient> };

/** One verified client per server process (surviving dev reloads); a failed start is retried on the next call. */
export function getDatabase(): Promise<PrismaClient> {
  cache.scoperoomDatabase ??= createDatabase().catch((error: unknown) => {
    cache.scoperoomDatabase = undefined;
    throw error;
  });
  return cache.scoperoomDatabase;
}
