import { createHash } from "node:crypto";

/**
 * Normalisation configuration.
 *
 * PRD section 11.6 requires the configuration to carry its own version and hash, and every stored
 * route fingerprint to retain the normaliser version. Two fingerprints produced under different
 * normalisers are not comparable, and without the version recorded alongside them that is
 * undetectable — a contract would appear to pass because the baseline was fingerprinted under
 * different rules.
 */

export interface NormaliserConfig {
  readonly version: string;
  /** Exact name replacements, applied before any identifier rewriting. */
  readonly aliases: Readonly<Record<string, string>>;
  /** Token prefixes whose volatile suffix is replaced, e.g. `run_` in `run_01JAB...`. */
  readonly identifierPrefixes: readonly string[];
  /** Replace a token consisting only of digits, as in `/orders/98271/refund`. */
  readonly replaceNumericSegments: boolean;
  /** Attribute keys whose value never affects route identity. */
  readonly volatileAttributes: readonly string[];
  /** Attribute keys compared case-insensitively. */
  readonly caseInsensitiveAttributes: readonly string[];
  /** Attribute keys that contribute to the canonical fingerprint. Everything else is evidence. */
  readonly fingerprintAttributes: readonly string[];
  /** Placeholder substituted for a recognised volatile identifier. */
  readonly identifierPlaceholder: string;
}

export const IDENTIFIER_PLACEHOLDER = "{id}";

/**
 * The default configuration.
 *
 * `fingerprintAttributes` is an allowlist, not a denylist. A denylist would silently admit every
 * new attribute into route identity, so one high-cardinality attribute added by a future service
 * would fragment every route family. An allowlist fails the other way: a genuinely
 * contract-relevant attribute that nobody added here is simply not part of identity, which is
 * visible and fixable.
 */
export const DEFAULT_NORMALISER_CONFIG: NormaliserConfig = {
  version: "1.0.0",
  aliases: {},
  identifierPrefixes: [
    "run_",
    "rfnd_",
    "ord-",
    "customer-",
    "cust_",
    "session_",
    "sess-",
    "req_",
    "trace-",
  ],
  replaceNumericSegments: true,
  volatileAttributes: [
    "agent.run.id",
    "agent.order.id",
    "agent.idempotency.key_hash",
    "service.instance.id",
    "trace_id",
    "span_id",
    "parent_span_id",
    "timestamp",
    "duration_nano",
  ],
  caseInsensitiveAttributes: ["agent.side_effect", "agent.data_domain", "agent.step.category"],
  fingerprintAttributes: [
    "agent.side_effect",
    "agent.data_domain",
    "agent.step.category",
    "gen_ai.tool.name",
    "gen_ai.operation.name",
  ],
  identifierPlaceholder: IDENTIFIER_PLACEHOLDER,
};

/**
 * Content hash of the configuration.
 *
 * Computed over a canonical serialisation with sorted keys and sorted arrays, so a configuration
 * that differs only in declaration order hashes identically. The version is what a human reads;
 * the hash is what proves the version was actually bumped when the rules changed.
 */
export function hashNormaliserConfig(config: NormaliserConfig): string {
  return createHash("sha256").update(canonicaliseConfig(config)).digest("hex");
}

function canonicaliseConfig(config: NormaliserConfig): string {
  const canonical = {
    version: config.version,
    aliases: Object.fromEntries(
      Object.entries(config.aliases).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    identifierPrefixes: [...config.identifierPrefixes].sort(),
    replaceNumericSegments: config.replaceNumericSegments,
    volatileAttributes: [...config.volatileAttributes].sort(),
    caseInsensitiveAttributes: [...config.caseInsensitiveAttributes].sort(),
    fingerprintAttributes: [...config.fingerprintAttributes].sort(),
    identifierPlaceholder: config.identifierPlaceholder,
  };
  return JSON.stringify(canonical);
}

export interface NormaliserIdentity {
  readonly version: string;
  readonly configHash: string;
}

export function identityOf(config: NormaliserConfig): NormaliserIdentity {
  return { version: config.version, configHash: hashNormaliserConfig(config) };
}
