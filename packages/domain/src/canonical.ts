import { createHash } from "node:crypto";

/**
 * Canonical JSON for anything that crosses the storage boundary.
 *
 * PostgreSQL `jsonb` stores object keys in its own order — by key length, then bytes — so a value
 * written from an object whose keys were sorted lexicographically comes back in a different order.
 * Nothing in FlightRules may depend on that: a canonical graph's serialisation is the input to a
 * route fingerprint, and a contract's canonical form is the input to its content hash.
 *
 * The rule for the whole persistence layer is therefore: canonicalise on the way in and on the way
 * out, never trust the order a row arrives in. `canonicalJson` is the one implementation, so a
 * round trip is provably a no-op rather than accidentally one.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Serialises with every object key in lexicographic order, at every depth.
 *
 * Array order is preserved: an array's order is meaning, not formatting. A non-finite number is
 * rejected rather than written as `null`, which is what `JSON.stringify` would silently do.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

export function canonicalise(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`A non-finite number cannot be stored canonically: ${String(value)}`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort(compareKeys)) {
      const entry = source[key];
      if (entry === undefined) continue;
      result[key] = canonicalise(entry);
    }
    return result;
  }
  throw new TypeError(`A ${typeof value} cannot be stored as JSON`);
}

/** The canonical form as a plain object, ready to hand to a `jsonb` parameter. */
export function canonicalObject(value: unknown): JsonValue {
  return canonicalise(value);
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
