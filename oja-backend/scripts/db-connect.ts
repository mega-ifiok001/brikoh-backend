import "dotenv/config";
import { createPrismaClient } from "../src/lib/prisma.js";

/**
 * One-off connection check against the real dev database.
 * Run with: npm run db:check
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in.");
  }

  const prisma = createPrismaClient(connectionString);
  try {
    const rows = await prisma.$queryRaw<{ now: Date }[]>`SELECT NOW() as now`;
    const serverTime = rows[0]?.now;
    console.log(
      "Connected to dev database. Server time:",
      serverTime instanceof Date ? serverTime.toISOString() : String(serverTime),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Connection failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
