import type {
  BuilderQueryPayload,
  OperationContext,
  SelectField,
  SigNozOperations,
} from "@flightrules/signoz-mcp";
import { buildTraceQuery, rowsOf } from "@flightrules/signoz-mcp";
import type { SpanRowData } from "@flightrules/trace-graph";
import type { RetrievedTrace } from "./eligibility.js";
import type { RetrievalSummary } from "./model.js";
import { compareStrings } from "./safety.js";
import type { MiningSelection } from "./selection.js";

/**
 * Dataset retrieval through the supported MCP Query Builder path (PRD Phase 08 tasks 1 and 2,
 * section 16.6).
 *
 * Two things here are load-bearing and both were established by probing the pinned server rather than
 * by reading documentation.
 *
 * **Field typing (SL-046).** A non-string tag requested without its `dataType` returns `null` on a
 * *successful* call, per column, with no error and no warning. So every declaration below carries a
 * type, and `verifyFieldTypes` checks each one against the type SigNoz itself reports before any
 * mining query runs. Returned values are then re-checked per row.
 *
 * **Truncation (SL-050).** `nextCursor` is empty exactly when the returned row count is below the
 * requested limit, and a non-empty opaque cursor when the page is full. A full page therefore means
 * "there may be more" and an empty cursor means "there is definitively no more". Stopping at
 * `maxTraces` while a cursor is still offered is truncation, and a truncated dataset may not found a
 * baseline.
 */

export interface FieldDeclaration {
  readonly name: string;
  readonly context: "span" | "resource" | "tag";
  readonly dataType: "string" | "number" | "bool";
}

/**
 * Every field the miner requests, with its type declared.
 *
 * The set is closed. A rule can only be proposed from an attribute that is retrieved, and a field
 * added here without a source-lock entry recording its verified type is exactly the mistake SL-046
 * describes.
 */
export const MINING_SELECT_FIELDS: readonly FieldDeclaration[] = [
  { name: "trace_id", context: "span", dataType: "string" },
  { name: "span_id", context: "span", dataType: "string" },
  { name: "parent_span_id", context: "span", dataType: "string" },
  { name: "name", context: "span", dataType: "string" },
  { name: "kind_string", context: "span", dataType: "string" },
  { name: "duration_nano", context: "span", dataType: "number" },
  { name: "timestamp", context: "span", dataType: "string" },
  { name: "status_code_string", context: "span", dataType: "string" },
  { name: "has_error", context: "span", dataType: "bool" },
  { name: "service.name", context: "resource", dataType: "string" },
  { name: "deployment.environment.name", context: "resource", dataType: "string" },
  { name: "agent.release.id", context: "tag", dataType: "string" },
  { name: "agent.run.id", context: "tag", dataType: "string" },
  { name: "agent.side_effect", context: "tag", dataType: "string" },
  { name: "agent.data_domain", context: "tag", dataType: "string" },
  { name: "agent.step.category", context: "tag", dataType: "string" },
  { name: "agent.retry.number", context: "tag", dataType: "number" },
  { name: "agent.idempotency.present", context: "tag", dataType: "bool" },
  { name: "gen_ai.tool.name", context: "tag", dataType: "string" },
  { name: "gen_ai.operation.name", context: "tag", dataType: "string" },
  { name: "gen_ai.usage.input_tokens", context: "tag", dataType: "number" },
  { name: "gen_ai.usage.output_tokens", context: "tag", dataType: "number" },
];

function toSelectField(field: FieldDeclaration): SelectField {
  return { name: field.name, context: field.context, dataType: field.dataType };
}

export const RETRIEVAL_ERROR_CODES = [
  "FIELD_CATALOGUE_UNAVAILABLE",
  "FIELD_TYPE_MISMATCH",
  "DISCOVERY_FAILED",
  "TRACE_FETCH_FAILED",
] as const;

export type RetrievalErrorCode = (typeof RETRIEVAL_ERROR_CODES)[number];

export interface RetrievalError {
  readonly code: RetrievalErrorCode;
  readonly subject: string;
  readonly message: string;
}

export interface FieldTypeReport {
  /** Fields whose declared type matches the type SigNoz reports. */
  readonly verified: readonly string[];
  /**
   * Fields the catalogue does not list.
   *
   * `timestamp` is a real span column the catalogue omits, and resource attributes are not listed at
   * all, so absence cannot be an error. It is only *safe* under two conditions, both enforced below:
   * a span or resource field must be declared `string`, which is the server's own default resolution;
   * and a tag absent from the catalogue was emitted by no span in the window, so a `null` return means
   * "not emitted" rather than "wrongly typed".
   */
  readonly unverified: readonly string[];
  readonly mismatched: readonly {
    readonly name: string;
    readonly declared: string;
    readonly reported: string;
  }[];
}

/** The catalogue reports a custom span attribute as `attribute`; the Query Builder calls it `tag`. */
function catalogueContextOf(context: FieldDeclaration["context"]): string {
  return context === "tag" ? "attribute" : context;
}

/**
 * Checks every declared field type against the type SigNoz reports.
 *
 * One call retrieves the whole catalogue — probed as 40 keys with `complete: true` against the pinned
 * server — so this costs one request rather than one per field. An incomplete catalogue is refused
 * rather than partially trusted.
 */
export async function verifyFieldTypes(
  operations: SigNozOperations,
  fields: readonly FieldDeclaration[],
  context: OperationContext,
): Promise<
  | { readonly ok: true; readonly report: FieldTypeReport }
  | { readonly ok: false; readonly error: RetrievalError }
> {
  const result = await operations.getFieldKeys({ signal: "traces" }, context);
  if (result.outcome !== "SUCCESS_WITH_ROWS") {
    return {
      ok: false,
      error: {
        code: "FIELD_CATALOGUE_UNAVAILABLE",
        subject: "signoz_get_field_keys",
        message: `The field catalogue could not be read (${result.outcome}), so no declared type can be confirmed.`,
      },
    };
  }
  if (result.value.data.complete === false) {
    return {
      ok: false,
      error: {
        code: "FIELD_CATALOGUE_UNAVAILABLE",
        subject: "signoz_get_field_keys",
        message:
          "SigNoz reported the field catalogue as incomplete, so a declared type cannot be confirmed against it.",
      },
    };
  }

  const catalogue = new Map<string, Set<string>>();
  for (const [name, descriptors] of Object.entries(result.value.data.keys ?? {})) {
    const types = catalogue.get(name) ?? new Set<string>();
    for (const descriptor of descriptors) {
      const dataType = descriptor.fieldDataType;
      if (dataType !== undefined && dataType.length > 0) {
        types.add(
          `${catalogueContextOf(descriptor.fieldContext as FieldDeclaration["context"])}:${dataType}`,
        );
      }
    }
    catalogue.set(name, types);
  }

  const verified: string[] = [];
  const unverified: string[] = [];
  const mismatched: { name: string; declared: string; reported: string }[] = [];

  for (const field of fields) {
    const types = catalogue.get(field.name);
    if (types === undefined || types.size === 0) {
      if (field.context !== "tag" && field.dataType !== "string") {
        mismatched.push({ name: field.name, declared: field.dataType, reported: "not catalogued" });
        continue;
      }
      unverified.push(field.name);
      continue;
    }

    const wanted = `${catalogueContextOf(field.context)}:${field.dataType}`;
    if (types.has(wanted)) {
      verified.push(field.name);
      continue;
    }
    mismatched.push({
      name: field.name,
      declared: wanted,
      reported: [...types].sort(compareStrings).join(", "),
    });
  }

  if (mismatched.length > 0) {
    return {
      ok: false,
      error: {
        code: "FIELD_TYPE_MISMATCH",
        subject: mismatched.map((entry) => entry.name).join(", "),
        message: mismatched
          .map(
            (entry) =>
              `${entry.name}: declared ${entry.declared}, SigNoz reports ${entry.reported}`,
          )
          .join("; "),
      },
    };
  }

  return {
    ok: true,
    report: {
      verified: verified.sort(compareStrings),
      unverified: unverified.sort(compareStrings),
      mismatched: [],
    },
  };
}

/**
 * Re-checks the values one row returned against the declared types.
 *
 * `null` is always acceptable: an attribute a span did not set comes back `null`, and so does a tag no
 * span in the window emitted at all. Anything else must match the declared type — a `bool` field
 * returning a string means the query resolved to a different column than the one intended, which is
 * the SL-046 failure mode caught after the fact.
 */
export function untrustedFieldsOf(
  rows: readonly SpanRowData[],
  fields: readonly FieldDeclaration[],
): readonly string[] {
  const untrusted = new Set<string>();

  for (const row of rows) {
    for (const field of fields) {
      if (!Object.hasOwn(row, field.name)) continue;
      const value = row[field.name];
      if (value === null || value === undefined) continue;
      const actual = typeof value;
      const expected =
        field.dataType === "bool" ? "boolean" : field.dataType === "number" ? "number" : "string";
      if (actual !== expected) untrusted.add(field.name);
    }
  }

  return [...untrusted].sort(compareStrings);
}

/** `nextCursor` across every result of one payload. Empty means the result set is complete. */
function cursorsOf(payload: BuilderQueryPayload): readonly string[] {
  return (payload.data.data.results ?? [])
    .map((result) => result.nextCursor ?? "")
    .filter((cursor) => cursor.length > 0);
}

export interface DiscoveredDataset {
  /** Candidate trace identifiers in discovery order, including repeats across pages. */
  readonly traceIds: readonly string[];
  readonly pages: number;
  readonly truncated: boolean;
}

/**
 * Discovers candidate runs by paging over the release's root spans.
 *
 * Ordered ascending by timestamp, which the pinned server was observed to page consistently: pages
 * taken at offsets 0 and 3 with limit 3 returned disjoint rows that concatenated exactly to the first
 * six rows of the unpaged result.
 */
export async function discoverRuns(
  operations: SigNozOperations,
  selection: MiningSelection,
  context: OperationContext,
): Promise<
  | { readonly ok: true; readonly dataset: DiscoveredDataset }
  | { readonly ok: false; readonly error: RetrievalError }
> {
  const traceIds: string[] = [];
  let pages = 0;
  let truncated = false;

  while (traceIds.length < selection.maxTraces) {
    const limit = Math.min(selection.batchSize, selection.maxTraces - traceIds.length);
    const result = await operations.executeBuilderQuery(
      buildTraceQuery({
        filter: discoveryFilter(selection),
        selectFields: [
          { name: "trace_id", context: "span", dataType: "string" },
          { name: "timestamp", context: "span", dataType: "string" },
        ],
        startMs: selection.startMs,
        endMs: selection.endMs,
        limit,
        offset: traceIds.length,
        orderDirection: "asc",
      }),
      context,
    );
    pages += 1;

    if (result.outcome === "SUCCESS_EMPTY") break;
    if (result.outcome !== "SUCCESS_WITH_ROWS") {
      return {
        ok: false,
        error: {
          code: "DISCOVERY_FAILED",
          subject: selection.releaseId,
          message: `Root-span discovery failed on page ${pages} with outcome ${result.outcome}.`,
        },
      };
    }

    const rows = rowsOf(result.value);
    for (const row of rows) {
      const traceId = row.data["trace_id"];
      if (typeof traceId === "string" && traceId.length > 0) traceIds.push(traceId);
    }

    const cursors = cursorsOf(result.value);
    if (rows.length < limit || cursors.length === 0) break;

    if (traceIds.length >= selection.maxTraces) {
      // The page was full and SigNoz still offers a continuation, so the window holds more runs than
      // the selection permitted fetching. That is truncation, not completion.
      truncated = true;
      break;
    }
  }

  return { ok: true, dataset: { traceIds, pages, truncated } };
}

/**
 * The discovery filter.
 *
 * The release identifier and the root span name are interpolated, so both are constrained by
 * `resolveSelection` to values that cannot close the quoted literal. SigNoz takes a filter *string*
 * rather than a structured object (SL-021), so there is no parameter binding to use instead.
 */
function discoveryFilter(selection: MiningSelection): string {
  const parts = [
    `agent.release.id = ${quoteValue(selection.releaseId)}`,
    `name = ${quoteValue(selection.rootSpanName)}`,
  ];
  if (selection.environment !== null) {
    parts.push(`deployment.environment.name = ${quoteValue(selection.environment)}`);
  }
  return parts.join(" AND ");
}

/**
 * Quotes a filter value.
 *
 * A value containing a quote, a backslash or a control character is rejected outright rather than
 * escaped. Escaping requires knowing the server's own escaping rules, and nothing in the pinned
 * server's documentation or observed behaviour establishes them — so the honest position is to refuse
 * the input rather than to guess at an escape that might not be one.
 */
function quoteValue(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (character === "'" || character === '"' || character === "\\" || code <= 0x1f) {
      throw new RangeError(
        "a filter value may not contain a quote, a backslash or a control character",
      );
    }
  }
  return `'${value}'`;
}

export interface FetchedDataset {
  readonly traces: readonly RetrievedTrace[];
  readonly failures: readonly RetrievalError[];
}

/**
 * Fetches the complete span set of each distinct trace, in bounded batches.
 *
 * Sequential by design. The pinned MCP server is a single process alongside SigNoz on the same host,
 * and PRD section 18.2 requires bounded trace fetches; issuing hundreds of concurrent Query Builder
 * requests would trade a bound the product controls for load the product cannot see.
 */
export async function fetchTraces(
  operations: SigNozOperations,
  traceIds: readonly string[],
  selection: MiningSelection,
  context: OperationContext,
): Promise<FetchedDataset> {
  const distinct = [...new Set(traceIds)].sort(compareStrings);
  const traces: RetrievedTrace[] = [];
  const failures: RetrievalError[] = [];

  for (const traceId of distinct) {
    const result = await operations.getTraceSpans(
      traceId,
      {
        selectFields: MINING_SELECT_FIELDS.map(toSelectField),
        startMs: selection.startMs,
        endMs: selection.endMs,
        limit: selection.maxSpansPerTrace,
        orderDirection: "asc",
      },
      context,
    );

    if (result.outcome !== "SUCCESS_WITH_ROWS") {
      failures.push({
        code: "TRACE_FETCH_FAILED",
        subject: traceId,
        message: `Fetching the spans of ${traceId} returned ${result.outcome}.`,
      });
      continue;
    }

    const rows = rowsOf(result.value).map((row) => row.data);
    traces.push({
      traceId,
      rows,
      webUrl: result.value.data.webUrl ?? null,
      untrustedFields: untrustedFieldsOf(rows, MINING_SELECT_FIELDS),
    });
  }

  return { traces, failures };
}

/** The retrieval summary a baseline records, so a proposal can state what it is founded on. */
export function retrievalSummary(input: {
  readonly selection: MiningSelection;
  readonly discovered: DiscoveredDataset;
  readonly fieldTypes: FieldTypeReport;
}): RetrievalSummary {
  return {
    pages: input.discovered.pages,
    batchSize: input.selection.batchSize,
    maxTraces: input.selection.maxTraces,
    truncated: input.discovered.truncated,
    startMs: input.selection.startMs,
    endMs: input.selection.endMs,
    fieldTypesVerified: input.fieldTypes.verified,
    fieldTypesUnverified: input.fieldTypes.unverified,
  };
}
