import type { NextConfig } from "next";

/**
 * FlightRules web application configuration.
 *
 * `transpilePackages` covers the workspace packages the app imports as TypeScript source. Nothing
 * here exposes an environment variable to the browser: `FLIGHTRULES_API_URL` is read only inside
 * `src/lib/api.ts`, which is `server-only`, so the API's location never reaches a client bundle
 * (PRD section 12.3).
 *
 * There is no `typescript.ignoreBuildErrors` here, and there must not be. It was set for as long as
 * this package resolved TypeScript 7.0.2, which Next.js 16.2.11 cannot detect at all: its setup
 * step probes the filesystem for `typescript/lib/typescript.js`, and TypeScript 7 ships a native
 * compiler that has no such file (SL-060, SL-067). Suppressing the resulting error suppressed the
 * type check and Next's route-type validation with it, and hid a second defect — with no type-check
 * worker to log through, `next/dist/build/type-check.js` discarded the error and exited `1` in
 * silence, which is exactly how it failed on GitHub Actions and nowhere else.
 *
 * `apps/web` now pins the TypeScript major Next.js 16.2.11 supports, so `next build` runs its own
 * TypeScript step *and* `pnpm run typecheck` runs `tsc -p tsconfig.json --noEmit` beforehand under
 * the workspace's full strict configuration — `exactOptionalPropertyTypes`,
 * `noUncheckedIndexedAccess` and the rest. `src/web.test.ts` asserts the probe still succeeds.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@flightrules/ui"],
};

export default config;
