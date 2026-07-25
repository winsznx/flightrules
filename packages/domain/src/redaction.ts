/**
 * Attribute keys FlightRules must never emit on the default product path (PRD section 17.6).
 * Every one exists in the released OpenTelemetry GenAI registry, so absence has to be asserted,
 * not assumed.
 */
export const FORBIDDEN_TELEMETRY_KEYS = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.tool.definitions",
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.retrieval.documents",
  "gen_ai.retrieval.query.text",
  "gen_ai.evaluation.explanation",
] as const;

export type ForbiddenTelemetryKey = (typeof FORBIDDEN_TELEMETRY_KEYS)[number];

const FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TELEMETRY_KEYS);

export function isForbiddenTelemetryKey(key: string): boolean {
  return FORBIDDEN_KEY_SET.has(key);
}

/** Key patterns whose values are redacted before any log line or evidence file is written. */
const SECRET_KEY_PATTERNS = [
  /api[-_]?key/i,
  /^authorization$/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /private[-_]?key/i,
  /signoz[-_]?api[-_]?key/i,
];

/**
 * Keys whose name contains "token" in its *unit-of-LLM-usage* sense rather than its credential
 * sense, and which therefore carry a number FlightRules must be able to report.
 *
 * `/token/i` above is deliberately broad — a key called `refreshToken` must never survive a log
 * line. But "token" is also the unit this product measures: `maxTokenRegressionPercent` is a gate
 * threshold and `tokens` is a change measurement, and redacting either destroys part of a release
 * decision. This was found by running the gate against live data, which returned
 * `"maxTokenRegressionPercent": "[redacted]"`.
 *
 * An exact-name allowlist rather than a cleverer pattern, on purpose. A pattern such as
 * "token followed by a plural" would also admit `access_tokens`, and the cost of getting a
 * redaction rule subtly wrong is a leaked credential. Every entry here is a key FlightRules itself
 * emits, holding an integer or a decimal string; adding one is a deliberate change, and a test
 * asserts that credential-shaped keys are still redacted.
 */
const TOKEN_MEASUREMENT_KEYS: ReadonlySet<string> = new Set([
  "tokens",
  "maxTokenRegressionPercent",
  "inputTokensP95",
  "outputTokensP95",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "tokenPercentile",
  "tokenMarginPercent",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.total_tokens",
]);

export const REDACTED = "[redacted]";

export function isSecretKey(key: string): boolean {
  if (TOKEN_MEASUREMENT_KEYS.has(key)) return false;
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Values registered here are replaced wherever they appear in a string, not only when they sit
 * under a suspicious key. The SigNoz API key is registered at startup so it cannot escape
 * through an interpolated message such as `failed with header SIGNOZ-API-KEY: abc`.
 */
const registeredSecrets = new Set<string>();

export function registerSecretValue(value: string): void {
  if (value.length >= 8) registeredSecrets.add(value);
}

export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

export function redactString(value: string): string {
  let result = value;
  for (const secret of registeredSecrets) {
    if (result.includes(secret)) result = result.split(secret).join(REDACTED);
  }
  return result;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Recursively redacts a structure for logging or evidence. Secret-keyed values are replaced
 * wholesale; every remaining string is scanned for registered secret values. Cycles are handled
 * so a malformed external payload cannot hang the logger.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): Json {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return redactString(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return null;
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) return "[circular]";
  seen.add(object);

  if (Array.isArray(object)) return object.map((item) => redact(item, seen));

  const result: Record<string, Json> = {};
  for (const [key, entryValue] of Object.entries(object as Record<string, unknown>)) {
    result[key] = isSecretKey(key) ? REDACTED : redact(entryValue, seen);
  }
  return result;
}
