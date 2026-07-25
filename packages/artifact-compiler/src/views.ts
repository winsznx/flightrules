import { ARTIFACT_LABELS, type ArtifactLabel, managedName, type NameScope } from "./names.js";
import { FIELDS, FILTERS, type TypedField } from "./queries.js";

/**
 * FR-013's four saved views.
 *
 * Shape taken verbatim from `signoz://view/instructions` on the pinned v0.9.0 server:
 * `compositeQuery` has exactly `queryType`, `panelType` and `queries`; every builder spec carries a
 * positive `limit` and a non-empty wire `order`; `signal` must equal `sourcePage`; and no legacy
 * v3/v4 field may appear or the server rejects the body with HTTP 400.
 *
 * PRD section 16.7 asks that rules expressible through Trace Matching be compiled into views where
 * practical, and that parentheses be preserved explicitly because operator precedence differs from
 * ordinary Boolean expectation. Every filter here is fully parenthesised for that reason.
 */

export interface SavedViewSpec {
  readonly name: string;
  readonly sourcePage: "traces";
  readonly category: string;
  readonly tags: readonly string[];
  readonly compositeQuery: {
    readonly queryType: "builder";
    readonly panelType: "list";
    readonly queries: readonly {
      readonly type: "builder_query";
      readonly spec: Record<string, unknown>;
    }[];
  };
}

function selectFields(fields: readonly TypedField[]): readonly Record<string, unknown>[] {
  return fields.map((field) => ({
    name: field.name,
    fieldContext: field.context,
    fieldDataType: field.dataType,
    signal: "traces",
  }));
}

function listQuery(filter: string, fields: readonly TypedField[]): SavedViewSpec["compositeQuery"] {
  return {
    queryType: "builder",
    panelType: "list",
    queries: [
      {
        type: "builder_query",
        spec: {
          name: "A",
          signal: "traces",
          source: "",
          stepInterval: 0,
          limit: 100,
          offset: 0,
          order: [{ key: { name: "timestamp" }, direction: "desc" }],
          filter: { expression: filter },
          having: { expression: "" },
          selectFields: selectFields(fields),
          disabled: false,
        },
      },
    ],
  };
}

export interface ViewDefinition {
  readonly label: ArtifactLabel;
  readonly filter: string;
  readonly fields: readonly TypedField[];
}

/**
 * The four views, in a fixed order.
 *
 * Declaration order is the compilation order and therefore part of the deterministic plan: the
 * artefact list must not depend on a database row order or on object key iteration.
 */
export function viewDefinitions(): readonly ViewDefinition[] {
  return [
    {
      label: ARTIFACT_LABELS.violatingRuns,
      filter: `(${FILTERS.violatingRuns()})`,
      fields: [
        FIELDS.evaluatedTraceId,
        FIELDS.releaseId,
        FIELDS.evaluationStatus,
        FIELDS.violationCount,
        FIELDS.zeroToleranceCount,
        FIELDS.contractVersion,
      ],
    },
    {
      label: ARTIFACT_LABELS.duplicateSideEffects,
      filter: `(${FILTERS.duplicateSideEffects()}) OR (${FILTERS.sideEffectingSteps()} AND ${
        FIELDS.retryNumber.name
      } > 0)`,
      fields: [
        FIELDS.evaluatedTraceId,
        FIELDS.releaseId,
        FIELDS.duplicateSideEffectCount,
        FIELDS.sideEffect,
        FIELDS.dataDomain,
        FIELDS.idempotencyPresent,
      ],
    },
    {
      label: ARTIFACT_LABELS.unknownRoutes,
      filter: `(${FILTERS.unknownRoutes()})`,
      fields: [
        FIELDS.evaluatedTraceId,
        FIELDS.releaseId,
        FIELDS.routeFingerprint,
        FIELDS.routeApproved,
        FIELDS.evaluationStatus,
      ],
    },
    {
      label: ARTIFACT_LABELS.releaseComparison,
      filter: `(${FILTERS.evaluatedRuns()})`,
      fields: [
        FIELDS.releaseId,
        FIELDS.evaluationStatus,
        FIELDS.violationCount,
        FIELDS.routeFingerprint,
        FIELDS.evaluatedTraceId,
        FIELDS.contractVersion,
      ],
    },
  ];
}

export function compileSavedViews(
  scope: NameScope,
  category: string,
  tags: readonly string[],
): readonly SavedViewSpec[] {
  return viewDefinitions().map((definition) => ({
    name: managedName(scope, definition.label),
    sourcePage: "traces" as const,
    category,
    tags: [...tags],
    compositeQuery: listQuery(definition.filter, definition.fields),
  }));
}

/**
 * The fields a read-back must agree on for a view to count as verified.
 *
 * Not every field: SigNoz populates `id`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy` and
 * normalises `extraData`, and comparing those would fail every verification for no reason. The
 * name, the explorer page and the query are what the product promised.
 */
export function viewMaterialFields(spec: SavedViewSpec): Readonly<Record<string, unknown>> {
  const query = spec.compositeQuery.queries[0]?.spec ?? {};
  const filter = query["filter"] as { readonly expression?: string } | undefined;
  return {
    name: spec.name,
    sourcePage: spec.sourcePage,
    "compositeQuery.queryType": spec.compositeQuery.queryType,
    "compositeQuery.panelType": spec.compositeQuery.panelType,
    // `selectFields` is deliberately absent: the server rewrites `fieldContext: "tag"` to
    // `"attribute"` on the round trip, so comparing it verbatim would fail every verification for
    // a difference the server itself introduced.
    "compositeQuery.queries.0.spec.filter.expression": filter?.expression,
    "compositeQuery.queries.0.spec.signal": query["signal"],
    "compositeQuery.queries.0.spec.limit": query["limit"],
  };
}
