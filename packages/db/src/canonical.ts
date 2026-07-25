/**
 * Canonical JSON, re-exported from `@flightrules/domain`.
 *
 * The implementation moved to the domain package in Phase 10 because the SigNoz artifact compiler
 * hashes its desired specifications with exactly the same function that the persistence layer uses
 * to write `jsonb`, and a compiler that imported the database package to get a pure serialiser
 * would have the dependency arrow pointing the wrong way. There is still one implementation; this
 * module keeps the persistence layer's existing import path intact.
 */
export type { JsonValue } from "@flightrules/domain";
export { canonicalHash, canonicalise, canonicalJson, canonicalObject } from "@flightrules/domain";
