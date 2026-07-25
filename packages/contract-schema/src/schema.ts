import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Location of the published JSON Schema.
 *
 * The schema is a data file rather than a generated constant so an editor, a CI step or another
 * language can consume it without running FlightRules. It is a structural contract only — the
 * TypeScript validator remains the authority, and a parity test asserts the two agree on every
 * fixture so the published file cannot drift into a comfortable fiction.
 *
 * Resolved from this module's own URL rather than from the working directory, so it is found
 * whether the package is imported from `src` during tests or from `dist` after a build.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

export const CONTRACT_SCHEMA_PATH = join(
  HERE,
  "..",
  "schema",
  "trajectory-contract.v1alpha1.schema.json",
);

export function readContractJsonSchema(): unknown {
  return JSON.parse(readFileSync(CONTRACT_SCHEMA_PATH, "utf8")) as unknown;
}
