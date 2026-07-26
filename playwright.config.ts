import { defineConfig, devices } from "@playwright/test";

/**
 * Browser validation (PRD section 22.4).
 *
 * These run against the **running product** — the built web application, the API, the worker, the
 * database and SigNoz — never against a mock. A run therefore proves the workflow, not the markup.
 *
 * Three projects, because PRD section 20.4 requires the product to work at all three widths and a
 * regression at one of them is invisible from the others. `desktop` is the reference; `narrow` is
 * the two-column breakpoint `base.css` declares at 900px; `mobile` is the single-column one at
 * 600px.
 *
 * `forbidOnly` and `retries: 0` are deliberate: a retried browser test hides a flake, and a flake in
 * a suite that talks to a real worker is usually a real race.
 */

const WEB = process.env["FLIGHTRULES_WEB_URL"] ?? "http://localhost:3100";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: ".playwright",
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: process.env["CI"] === undefined ? [["list"]] : [["list"], ["github"]],
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    // Read-only, at the three widths PRD section 20.4 requires. These run against the seeded demo
    // and leave it exactly as they found it.
    {
      name: "desktop",
      testIgnore: /phase-13-workflow/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "narrow",
      testIgnore: /phase-13-workflow/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 900 } },
    },
    { name: "mobile", testIgnore: /phase-13-workflow/, use: { ...devices["Pixel 7"] } },
    // Destructive, and therefore last. Phase 13's exit gate begins by purging the managed SigNoz
    // artefacts and resetting the demo database — which is the point of it, and which would
    // invalidate every read-only assertion above if it ran first. Declared last, with one worker,
    // so ordering is a property of the configuration rather than of a developer's memory.
    {
      name: "workflow",
      testMatch: /phase-13-workflow/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
