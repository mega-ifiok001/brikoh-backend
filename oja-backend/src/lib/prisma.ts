import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Creates a Prisma client connected to the given Postgres connection
 * string (defaults to DATABASE_URL from the validated environment).
 *
 * Prisma 7 uses driver adapters: the pg adapter supplies the connection,
 * so the URL is never baked into the generated client at build time.
 */
export function createPrismaClient(connectionString?: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: connectionString ?? process.env.DATABASE_URL,
    // Keep the pool modest: integration tests open one client here plus
    // the app's shared client against the same local database, and a
    // small pool keeps connection counts predictable.
    max: 5,
  });
  return new PrismaClient({
    adapter,
    // Headroom for interactive-transaction connection acquisition: some
    // environments (cold databases, slow disks, network conditions) take
    // longer than Prisma's 2s default maxWait to hand out a connection,
    // which surfaced as intermittent "Unable to start a transaction"
    // failures. 20s budgets make that unobservable.
    transactionOptions: { maxWait: 20_000, timeout: 20_000 },
  });
}

let sharedClient: PrismaClient | undefined;

/**
 * Shared client used by services and middleware. In test runs
 * (NODE_ENV=test, e.g. under vitest) it targets the test database via
 * TEST_DATABASE_URL so integration suites never touch dev data; in
 * development and production it uses DATABASE_URL.
 */
export function getPrismaClient(): PrismaClient {
  sharedClient ??= createPrismaClient(
    process.env.NODE_ENV === "test" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL,
  );
  return sharedClient;
}
