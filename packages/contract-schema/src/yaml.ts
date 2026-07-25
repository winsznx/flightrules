import { isAlias, type Node, parseDocument, visit, YAMLError } from "yaml";
import type { ErrorBag, ValidationError } from "./errors.js";
import { CONTRACT_LIMITS } from "./types.js";

/**
 * Safe YAML loading.
 *
 * Every behaviour asserted here was established by running `yaml@2.9.0`, not read from its
 * documentation, and three of the findings contradict what the options suggest:
 *
 * - `customTags: []` and `schema: "core"` do **not** disable dangerous tags. `!!binary` yields a
 *   Node `Buffer` and `!!timestamp` yields a `Date`, both with no error and no warning at all.
 *   Only `!!python/object:...` produces even a warning, and it still parses to a plain string.
 * - So the tag defence cannot be an option or a warning check. It has to walk the document and
 *   reject any node carrying an explicit tag.
 * - Deep flow nesting fails with `Maximum call stack size exceeded` wrapped in a `YAMLParseError`.
 *   That is caught rather than fatal, but the threshold depends on the available stack, so depth is
 *   bounded explicitly first and the rejection is deterministic.
 *
 * A contract has no legitimate use for anchors, aliases or explicit tags, so all three are refused
 * outright rather than bounded. `maxAliasCount: 0` turns any alias into
 * `ReferenceError: Alias resolution is disabled`, which is a stronger position than the default
 * amplification limit.
 */

/**
 * Parser options. `maxAliasCount: 0` is the security control; the rest lock the dialect so a
 * document cannot mean two things depending on the parser's defaults.
 */
const PARSE_OPTIONS = {
  version: "1.2" as const,
  schema: "core" as const,
  strict: true,
  uniqueKeys: true,
  merge: false,
  maxAliasCount: 0,
  keepSourceTokens: false,
  prettyErrors: false,
} as const;

export type LoadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/** Root path for every diagnostic produced here, so a load error reads like a validation error. */
const DOCUMENT_PATH = "$document";

/**
 * Cheap pre-checks run before the parser sees the source.
 *
 * These exist so a hostile document is rejected on size rather than surviving into a parse whose
 * cost depends on its content.
 */
function checkSourceBounds(source: string, bag: ErrorBag): boolean {
  if (source.trim().length === 0) {
    bag.add(DOCUMENT_PATH, "SOURCE_EMPTY", "The contract document is empty.");
    return false;
  }

  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > CONTRACT_LIMITS.maxSourceBytes) {
    bag.add(
      DOCUMENT_PATH,
      "SOURCE_TOO_LARGE",
      `The contract document is ${bytes} bytes; the maximum is ${CONTRACT_LIMITS.maxSourceBytes}.`,
    );
    return false;
  }

  // Counted without splitting the string, so a document made entirely of newlines does not
  // allocate an array proportional to its own size just to be rejected.
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 0x0a) lines += 1;
  }
  if (lines > CONTRACT_LIMITS.maxSourceLines) {
    bag.add(
      DOCUMENT_PATH,
      "SOURCE_TOO_MANY_LINES",
      `The contract document has ${lines} lines; the maximum is ${CONTRACT_LIMITS.maxSourceLines}.`,
    );
    return false;
  }

  return true;
}

/** Renders a `yaml` node path as the dotted form used everywhere else. */
function renderPath(path: readonly unknown[]): string {
  const parts: string[] = [];
  for (const entry of path) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { readonly key?: unknown; readonly items?: unknown };
    const key = record.key;
    if (key !== undefined && key !== null && typeof key === "object" && "value" in key) {
      const value = (key as { readonly value: unknown }).value;
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.length === 0 ? DOCUMENT_PATH : parts.join(".");
}

/**
 * Rejects anchors, aliases and explicit tags, and bounds nesting depth.
 *
 * Depth is measured from the visitor's own path length rather than by recursion, so a document that
 * would overflow the parser's stack on conversion is refused before `toJS` is called.
 */
function auditDocumentTree(document: ReturnType<typeof parseDocument>, bag: ErrorBag): void {
  let deepest = 0;

  visit(document, {
    Node(_key, node: Node, path) {
      const depth = path.length;
      if (depth > deepest) deepest = depth;

      if (isAlias(node)) {
        bag.add(
          renderPath(path),
          "YAML_ALIAS_FORBIDDEN",
          `The alias "*${node.source}" is not permitted in a contract. Write the value out in full.`,
        );
      }

      const anchor = (node as { readonly anchor?: unknown }).anchor;
      if (typeof anchor === "string" && anchor.length > 0) {
        bag.add(
          renderPath(path),
          "YAML_ANCHOR_FORBIDDEN",
          `The anchor "&${anchor}" is not permitted in a contract.`,
        );
      }

      // The decisive check. `!!binary` and `!!timestamp` are accepted silently by the parser and
      // produce a Buffer and a Date; an unresolved tag such as `!!python/object:os.system` produces
      // only a warning. All three carry an explicit tag, and none of them belongs in a contract.
      const tag = (node as { readonly tag?: unknown }).tag;
      if (typeof tag === "string" && tag.length > 0) {
        bag.add(
          renderPath(path),
          "YAML_TAG_FORBIDDEN",
          `The explicit YAML tag "${tag}" is not permitted in a contract.`,
        );
      }
    },
  });

  if (deepest > CONTRACT_LIMITS.maxNestingDepth) {
    bag.add(
      DOCUMENT_PATH,
      "YAML_TOO_DEEP",
      `The document nests ${deepest} levels deep; the maximum is ${CONTRACT_LIMITS.maxNestingDepth}.`,
    );
  }
}

/**
 * Audits the converted value.
 *
 * The tag check above already refuses the constructs that produce a `Buffer` or a `Date`, but this
 * runs anyway: it is the check that does not depend on knowing every tag the parser might resolve,
 * and it also catches the numeric hazards, which have nothing to do with tags. `.inf` and `.nan`
 * parse to non-finite numbers, and an integer beyond 2^53 loses precision silently —
 * `99999999999999999999999` becomes `1e+23`.
 */
function auditValue(value: unknown, path: string, bag: ErrorBag, depth: number): void {
  if (depth > CONTRACT_LIMITS.maxNestingDepth) {
    bag.add(
      path,
      "YAML_TOO_DEEP",
      `The value nests deeper than the maximum of ${CONTRACT_LIMITS.maxNestingDepth}.`,
    );
    return;
  }

  if (value === null) return;

  switch (typeof value) {
    case "string":
      return;
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        bag.add(path, "INVALID_NUMBER", "A contract may not contain infinity or not-a-number.");
      } else if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        bag.add(
          path,
          "INVALID_NUMBER",
          "This integer is too large to represent exactly. Use a value within 2^53.",
        );
      }
      return;
    case "bigint":
      bag.add(path, "UNSUPPORTED_VALUE_TYPE", "A contract may not contain a big integer.");
      return;
    case "object":
      break;
    default:
      bag.add(
        path,
        "UNSUPPORTED_VALUE_TYPE",
        `A contract may not contain a value of type ${typeof value}.`,
      );
      return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      auditValue(item, `${path}[${index}]`, bag, depth + 1);
    }
    return;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    bag.add(
      path,
      "UNSUPPORTED_VALUE_TYPE",
      `A contract may not contain a ${(value as object).constructor?.name ?? "non-plain"} value.`,
    );
    return;
  }

  // `Object.keys`, so a document containing a literal `__proto__` key is inspected as data. The
  // parser does not pollute the prototype, but the key still arrives as an own property.
  for (const key of Object.keys(value as Record<string, unknown>)) {
    auditValue(
      (value as Record<string, unknown>)[key],
      path === DOCUMENT_PATH ? key : `${path}.${key}`,
      bag,
      depth + 1,
    );
  }
}

/**
 * Parses a contract document into plain JSON-compatible data.
 *
 * Returns diagnostics rather than throwing: an invalid contract is an expected outcome of
 * validating one, not an exceptional condition.
 */
export function loadContractDocument(source: string, bag: ErrorBag): LoadResult {
  if (!checkSourceBounds(source, bag)) return { ok: false, errors: bag.toList() };

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, PARSE_OPTIONS);
  } catch (error: unknown) {
    bag.add(DOCUMENT_PATH, "YAML_MALFORMED", describeYamlFailure(error));
    return { ok: false, errors: bag.toList() };
  }

  for (const error of document.errors) {
    const code = error.code === "DUPLICATE_KEY" ? "YAML_DUPLICATE_KEY" : "YAML_MALFORMED";
    bag.add(DOCUMENT_PATH, code, firstLineOf(error.message));
  }
  // A warning is never ignored. `TAG_RESOLVE_FAILED` is the only warning the probes produced, and
  // an unresolved tag is exactly the case that must not be accepted quietly.
  for (const warning of document.warnings) {
    bag.add(DOCUMENT_PATH, "YAML_MALFORMED", firstLineOf(warning.message));
  }

  auditDocumentTree(document, bag);
  if (!bag.empty) return { ok: false, errors: bag.toList() };

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error: unknown) {
    bag.add(DOCUMENT_PATH, "YAML_MALFORMED", describeYamlFailure(error));
    return { ok: false, errors: bag.toList() };
  }

  auditValue(value, DOCUMENT_PATH, bag, 0);
  if (!bag.empty) return { ok: false, errors: bag.toList() };

  return { ok: true, value };
}

/**
 * Describes a parser failure without leaking the document.
 *
 * A `YAMLParseError` message embeds the offending source line, which for a contract is harmless,
 * but an alias failure arrives as a plain `ReferenceError` and a stack overflow arrives as a
 * `RangeError`, so the type cannot be assumed.
 */
function describeYamlFailure(error: unknown): string {
  if (error instanceof YAMLError) return firstLineOf(error.message);
  if (error instanceof RangeError) {
    return "The document is too deeply nested for the YAML parser.";
  }
  if (error instanceof ReferenceError) return firstLineOf(error.message);
  if (error instanceof Error) return firstLineOf(error.message);
  return "The document could not be parsed as YAML.";
}

function firstLineOf(message: string): string {
  const line = message.split("\n", 1)[0] ?? message;
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** Exported for the tests that assert the dialect is locked, not merely intended. */
export const YAML_PARSE_OPTIONS = PARSE_OPTIONS;
