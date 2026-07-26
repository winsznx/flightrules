import type { SideEffect } from "@flightrules/domain";
import { toSideEffect } from "@flightrules/domain";
import { DEFAULT_NORMALISER_CONFIG, type NormaliserConfig } from "./config.js";
import {
  detokenise,
  isAllDigits,
  isLongHex,
  isUlid,
  isUuid,
  splitPrefixedIdentifier,
  tokenise,
} from "./identifiers.js";

/**
 * The normalisation pipeline of PRD section 11.6, in the order the PRD specifies.
 *
 * The order is not incidental. Alias mapping runs before identifier replacement so an alias can
 * name a raw span; identifier replacement runs before case folding so a mixed-case hex identifier
 * is recognised as one; and classification runs last so it sees the finished value.
 */

export const NORMALISATION_STEPS = [
  "trim_and_unicode_normalise",
  "map_aliases",
  "replace_uuids",
  "replace_ulids",
  "replace_long_hex",
  "replace_numeric_segments",
  "replace_configured_identifiers",
  "lower_case_configured_fields",
  "remove_volatile_attributes",
  "classify",
] as const;

export type NormalisationStep = (typeof NORMALISATION_STEPS)[number];

/**
 * Rewrites every volatile identifier in a name.
 *
 * All identifier rules run in one tokenised pass rather than five sequential string rewrites.
 * The result is the same because the rules are disjoint — a token cannot be both a UUID and a
 * ULID — and one pass means the cost stays linear in the name's length no matter how many rules
 * are configured.
 */
export function normaliseName(value: string, config: NormaliserConfig): string {
  const trimmed = value.trim().normalize("NFC");
  // `Object.hasOwn`, not a bare index. Span names are external input, and a span named `toString`
  // or `valueOf` would otherwise resolve to a function on `Object.prototype` and be substituted
  // for the name. Found by the property test that asserts arbitrary input never throws.
  const aliased = Object.hasOwn(config.aliases, trimmed)
    ? (config.aliases[trimmed] as string)
    : trimmed;

  const parts = tokenise(aliased);
  const tokens = parts.tokens.map((token) => {
    if (token.length === 0) return token;

    if (isUuid(token)) return config.identifierPlaceholder;
    if (isUlid(token)) return config.identifierPlaceholder;
    if (isLongHex(token)) return config.identifierPlaceholder;
    if (config.replaceNumericSegments && isAllDigits(token)) return config.identifierPlaceholder;

    const prefixed = splitPrefixedIdentifier(token, config.identifierPrefixes);
    if (prefixed !== undefined && prefixed.suffix.length > 0) {
      return `${prefixed.prefix}${config.identifierPlaceholder}`;
    }

    return token;
  });

  return detokenise({ tokens, separators: parts.separators });
}

export type SafeScalar = string | number | boolean | null;
export type SafeAttributeValue = SafeScalar | readonly SafeScalar[];

function isSafeScalar(value: unknown): value is SafeScalar {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  return type === "number" && Number.isFinite(value);
}

/**
 * Coerces an arbitrary attribute value into the safe scalar set.
 *
 * Anything that is not a scalar or an array of scalars becomes `null` rather than being stringified.
 * A stringified object would carry its key order into the fingerprint, which is exactly the
 * ordering dependence FR-006 forbids.
 */
export function toSafeAttributeValue(value: unknown): SafeAttributeValue {
  if (isSafeScalar(value)) return value;
  if (Array.isArray(value)) {
    const scalars = value.filter(isSafeScalar);
    return scalars.length === value.length ? scalars : null;
  }
  if (typeof value === "bigint") return value.toString();
  return null;
}

export interface NormalisedAttributes {
  /** Attributes that contribute to route identity, keys sorted, set values sorted. */
  readonly fingerprint: Readonly<Record<string, SafeAttributeValue>>;
  /** Everything else, kept as evidence but excluded from identity. */
  readonly evidence: Readonly<Record<string, SafeAttributeValue>>;
}

function sortValue(value: SafeAttributeValue): SafeAttributeValue {
  if (!Array.isArray(value)) return value;
  // Sorted by serialised form so a mixed-type array orders deterministically.
  return [...value].sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Splits and normalises a span's attributes.
 *
 * Volatile keys are dropped from both outputs, not merely from the fingerprint: PRD section 18.3
 * keeps only safe summaries locally, and an identifier that cannot affect identity has no reason
 * to be copied into stored evidence either.
 */
export function normaliseAttributes(
  attributes: Readonly<Record<string, unknown>>,
  config: NormaliserConfig,
): NormalisedAttributes {
  const volatile = new Set(config.volatileAttributes);
  const caseInsensitive = new Set(config.caseInsensitiveAttributes);
  const identity = new Set(config.fingerprintAttributes);

  // Null-prototype records. Attribute keys are telemetry-derived and therefore untrusted: on a
  // normal object, `record["__proto__"] = ["a","b"]` invokes the inherited setter and *replaces the
  // record's prototype* instead of storing a key, after which `record.length` and `record[0]`
  // return values no span ever emitted. With no prototype there is no setter, so the key is stored
  // as ordinary data and the record cannot inherit anything.
  const fingerprint: Record<string, SafeAttributeValue> = Object.create(null);
  const evidence: Record<string, SafeAttributeValue> = Object.create(null);

  for (const key of Object.keys(attributes).sort()) {
    if (volatile.has(key)) continue;

    let value = toSafeAttributeValue(attributes[key]);
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.length === 0) continue;

    if (caseInsensitive.has(key) && typeof value === "string") value = value.toLowerCase();
    value = sortValue(value);

    if (identity.has(key)) fingerprint[key] = value;
    else evidence[key] = value;
  }

  return { fingerprint, evidence };
}

export interface Classification {
  readonly sideEffect: SideEffect;
  readonly dataDomain: string | null;
  readonly toolName: string | null;
  readonly toolType: string | null;
  readonly retryNumber: number | null;
  readonly releaseId: string | null;
  readonly environment: string | null;
}

function stringAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = attributes[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A non-negative integer attribute, or `null`.
 *
 * `agent.retry.number` is a zero-based attempt index, so a negative value is not a smaller number of
 * retries — it is not an attempt index at all. Admitting one lets a single mislabelled span subtract
 * from the run's retry total and from the release's summed retries, which turns a real budget breach
 * into a clean run. Rejecting it reports the span as carrying no retry evidence, which is what an
 * uninterpretable value actually is.
 */
function nonNegativeIntegerAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = attributes[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  // SigNoz returns some numeric tags as strings depending on the selected data type. `isAllDigits`
  // admits no sign, so the string path cannot carry a negative value.
  if (typeof value === "string" && isAllDigits(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Derives the contract-relevant classifications from a span's attributes.
 *
 * An unclassified side effect resolves to `unknown`, never to `none`. A rule that forbids a
 * duplicated write must be able to tell "this span performed no write" from "nobody said what
 * this span did", and collapsing the two would let an uninstrumented service silently pass.
 */
export function classify(
  attributes: Readonly<Record<string, unknown>>,
  config: NormaliserConfig,
): Classification {
  const rawSideEffect = stringAttribute(attributes, "agent.side_effect");
  const sideEffect = toSideEffect(rawSideEffect === null ? undefined : rawSideEffect.toLowerCase());

  const toolName = stringAttribute(attributes, "gen_ai.tool.name");
  const dataDomain = stringAttribute(attributes, "agent.data_domain");

  return {
    sideEffect,
    dataDomain: dataDomain === null ? null : dataDomain.toLowerCase(),
    toolName: toolName === null ? null : normaliseName(toolName, config),
    toolType: stringAttribute(attributes, "gen_ai.operation.name"),
    retryNumber: nonNegativeIntegerAttribute(attributes, "agent.retry.number"),
    releaseId: stringAttribute(attributes, "agent.release.id"),
    environment: stringAttribute(attributes, "deployment.environment.name"),
  };
}

export { DEFAULT_NORMALISER_CONFIG };
