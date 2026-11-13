// Prisma CLI configuration (migrate, generate, seed).
// Runtime code uses src/config/env.ts + src/lib/prisma.ts instead.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
    // Optional shadow DB for non-interactive `migrate diff` against a
    // migrations directory (CI and scripted generation). `migrate dev`
    // still auto-creates a shadow when this is unset.
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
