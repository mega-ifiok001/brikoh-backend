import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";

/**
 * Cross-platform sleep used by the retry loop below. Uses PowerShell's
 * Start-Sleep on Windows where `sleep` is not an executable; on POSIX the
 * standard `sleep` command is used.
 */
function sleepSync(seconds: number): void {
  if (process.platform === "win32") {
    execSync(`powershell -NoProfile -Command "Start-Sleep -Seconds ${seconds}"`, { stdio: "inherit" });
  } else {
    execSync(`sleep ${seconds}`, { stdio: "inherit" });
  }
}

/**
 * Runs `prisma migrate deploy` against the TEST database before the suite.
 * The child process inherits process.env, with .env.test values overriding
 * so the Prisma CLI (prisma.config.ts) targets the test database via the
 * direct (non-pooler) endpoint. Locally .env.test holds the connection
 * string; in CI the secrets arrive as environment variables and there is
 * no .env.test file.
 */
export default function globalSetup(): void {
  const testEnv = existsSync(".env.test") ? dotenv.parse(readFileSync(".env.test", "utf-8")) : {};

  const testDatabaseUrl = testEnv.TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is required (via .env.test or environment)");
  }

  runMigrateDeploy({
    ...process.env,
    ...testEnv,
    DATABASE_URL: testDatabaseUrl,
    MIGRATE_DATABASE_URL: testDatabaseUrl,
  });
}

/**
 * Runs `prisma migrate deploy` with retries. Neon autosuspends idle
 * computes: the first connection after idle is often refused while the
 * compute cold-starts, so a couple of retries with a backoff make the
 * test run resilient to that.
 */
function runMigrateDeploy(env: NodeJS.ProcessEnv): void {
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      execSync("npx prisma migrate deploy", { stdio: "inherit", env });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        sleepSync(attempt * 3);
      }
    }
  }
  throw lastError;
}
