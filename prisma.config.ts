import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Guarded migration scripts supply this URL. Client generation needs no database.
  datasource: { url: process.env.MIGRATION_DATABASE_URL ?? "" },
});