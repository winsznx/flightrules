import type { NextConfig } from "next";

/**
 * FlightRules web application configuration.
 *
 * `transpilePackages` covers the workspace packages the app imports as TypeScript source. Nothing
 * here exposes an environment variable to the browser: `FLIGHTRULES_API_URL` is read only inside
 * `src/lib/api.ts`, which is `server-only`, so the API's location never reaches a client bundle
 * (PRD section 12.3).
 *
 * `typescript.ignoreBuildErrors` does **not** mean this application is unchecked. Next.js 16.2.11's
 * built-in TypeScript step cannot drive TypeScript 7.0.2 — it fails to detect it, tries to install
 * it on every build, and then crashes the build worker (SL-060). SL-033 verified the working path:
 * `tsc -p apps/web/tsconfig.json`, which runs in this package's `typecheck` script, in `pnpm build`
 * before `next build`, and in the workspace-wide `make typecheck`. The strict configuration —
 * `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and the rest — is fully enforced there.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@flightrules/ui"],
  typescript: { ignoreBuildErrors: true },
};

export default config;
