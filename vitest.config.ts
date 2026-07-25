import { defineConfig } from "vitest/config";

/**
 * Three projects, deliberately separated by what external service each needs:
 *
 * - `unit`            no external service. `make test`.
 * - `integration-db`  real PostgreSQL. `*.integration.test.ts`.
 * - `integration-signoz` a deployed SigNoz stack with MCP. `*.signoz.integration.test.ts`.
 *
 * The split is by dependency rather than by conditional skips inside one suite, so CI can run
 * exactly the project whose dependency it provides. No project silently skips: each fails loudly
 * at import time when its dependency is absent, because a skipped test that reports green is the
 * false evidence this project forbids.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: [
            "**/*.integration.test.ts",
            "**/*.signoz.integration.test.ts",
            "**/node_modules/**",
            "**/dist/**",
          ],
          environment: "node",
          globals: false,
          restoreMocks: true,
        },
      },
      {
        test: {
          name: "integration-db",
          include: [
            "packages/*/src/**/*.integration.test.ts",
            "apps/*/src/**/*.integration.test.ts",
            "apps/demo-services/*/src/**/*.integration.test.ts",
          ],
          exclude: ["**/*.signoz.integration.test.ts", "**/node_modules/**", "**/dist/**"],
          environment: "node",
          globals: false,
          restoreMocks: true,
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "integration-signoz",
          include: [
            "packages/*/src/**/*.signoz.integration.test.ts",
            "apps/*/src/**/*.signoz.integration.test.ts",
            "apps/demo-services/*/src/**/*.signoz.integration.test.ts",
          ],
          exclude: ["**/node_modules/**", "**/dist/**"],
          environment: "node",
          globals: false,
          restoreMocks: true,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
