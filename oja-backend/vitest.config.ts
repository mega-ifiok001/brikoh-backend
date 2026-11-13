import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["vitest.setup.ts"],
    globalSetup: ["vitest.global-setup.ts"],
    include: ["src/**/*.test.ts", "prisma/**/*.test.ts"],
    // The integration suites (schema.test.ts, auth.integration.test.ts)
    // wipe the shared test database in their setup hooks. Files must run
    // sequentially, or they clobber each other mid-test.
    fileParallelism: false,
    // The test database lives on Neon, whose free-tier computes autosuspend
    // when idle. First queries after a cold start are slow, so give
    // integration tests (and their hooks) generous budgets instead of the
    // 5s/10s vitest defaults. Unit tests are unaffected — they run in ms.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
