import { defineConfig } from "vitest/config";

/**
 * Two projects, deliberately separated:
 *
 * - `unit` runs anywhere with no external service and is what `make test` runs.
 * - `integration` requires real PostgreSQL, a real SigNoz stack, or both. It never silently
 *   skips: if a dependency is missing the suite fails loudly, because a skipped integration
 *   test that reports success is exactly the false evidence this project forbids.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
          environment: "node",
          globals: false,
          restoreMocks: true,
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "packages/*/src/**/*.integration.test.ts",
            "apps/*/src/**/*.integration.test.ts",
            "apps/demo-services/*/src/**/*.integration.test.ts",
          ],
          exclude: ["**/node_modules/**", "**/dist/**"],
          environment: "node",
          globals: false,
          restoreMocks: true,
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
