import { z } from "zod";

/**
 * Runtime schemas for the payloads the pinned SigNoz MCP Server actually returns. Every shape
 * here was observed against v0.9.0; none is inferred from documentation.
 *
 * Schemas are deliberately permissive about *extra* fields and strict about the fields
 * FlightRules reads. SigNoz adds columns between versions, and a client that rejects an
 * unrecognised field would break on an upgrade that changed nothing FlightRules depends on. It
 * must, however, refuse a payload whose required fields are absent, because that is the case
 * where continuing would produce a confidently wrong graph.
 */

/** Query Builder rows are `{data: {...}, timestamp: string}`; the column set varies by request. */
export const builderRowSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  timestamp: z.string().optional(),
});

export type BuilderRow = z.infer<typeof builderRowSchema>;

const builderResultSchema = z.object({
  queryName: z.string().optional(),
  nextCursor: z.string().optional(),
  // A query that matched nothing returns `rows: null`, not an empty array.
  rows: z.array(builderRowSchema).nullable().optional(),
});

const builderMetaSchema = z.object({
  rowsScanned: z.number().optional(),
  bytesScanned: z.number().optional(),
  durationMs: z.number().optional(),
});

/**
 * `signoz_execute_builder_query` wraps its results twice: `{status, data:{data:{results}}}`.
 * `signoz_get_trace_details` returns the inner envelope without the `status` wrapper, so both
 * nestings are accepted and reduced to one shape by the reader.
 */
export const builderQueryPayloadSchema = z.object({
  status: z.string().optional(),
  data: z.object({
    type: z.string().optional(),
    meta: builderMetaSchema.optional(),
    webUrl: z.string().optional(),
    data: z.object({
      results: z.array(builderResultSchema).nullable().optional(),
    }),
  }),
});

export type BuilderQueryPayload = z.infer<typeof builderQueryPayloadSchema>;

/** Every list tool returns this envelope, with `structuredContent` mirroring it. */
export const listPayloadSchema = z.object({
  data: z.array(z.unknown()).nullable(),
  pagination: z
    .object({
      total: z.number().optional(),
      offset: z.number().optional(),
      limit: z.number().optional(),
      hasMore: z.boolean().optional(),
      nextOffset: z.number().optional(),
    })
    .optional(),
});

export type ListPayload = z.infer<typeof listPayloadSchema>;

/**
 * `signoz_get_field_keys` does not use the list envelope. It returns a map keyed by field name,
 * each value an array of descriptors — one per context the key was seen in.
 */
export const fieldKeyDescriptorSchema = z.object({
  name: z.string(),
  signal: z.string().optional(),
  fieldContext: z.string().optional(),
  fieldDataType: z.string().optional(),
});

export const fieldKeysPayloadSchema = z.object({
  status: z.string().optional(),
  data: z.object({
    keys: z.record(z.string(), z.array(fieldKeyDescriptorSchema)).nullable(),
    complete: z.boolean().optional(),
  }),
});

export type FieldKeysPayload = z.infer<typeof fieldKeysPayloadSchema>;

/**
 * `signoz_get_field_values` uses yet another envelope, grouping values by their data type. Three
 * discovery-adjacent tools, three different shapes — which is why each reader carries its own
 * schema rather than sharing one generic list envelope.
 */
export const fieldValuesPayloadSchema = z.object({
  status: z.string().optional(),
  data: z.object({
    values: z
      .object({
        stringValues: z.array(z.string()).nullable().optional(),
        boolValues: z.array(z.boolean()).nullable().optional(),
        numberValues: z.array(z.number()).nullable().optional(),
      })
      .nullable(),
    complete: z.boolean().optional(),
  }),
});

export type FieldValuesPayload = z.infer<typeof fieldValuesPayloadSchema>;

/** A create call returns the new identifier under `data`. */
export const createdResourceSchema = z.object({
  data: z.union([
    z.object({ id: z.string() }),
    // Some create tools return the identifier as a bare string under `data`.
    z.string(),
  ]),
});

/**
 * `signoz_create_notification_channel` does not use the create envelope.
 *
 * It returns `{channel: {status, data: {...}}, test_notification: {...}}`, because the server
 * **sends a real test notification** as part of creation and reports whether the destination
 * accepted it. That is a genuine delivery signal and FlightRules records it verbatim rather than
 * assuming a created channel delivers (Phase 10 evidence, SL-055).
 */
export const createdChannelSchema = z.object({
  channel: z.object({
    status: z.string().optional(),
    data: z.object({ id: z.string() }).catchall(z.unknown()),
  }),
  test_notification: z
    .object({
      success: z.boolean().optional(),
      message: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
});

export type CreatedChannelPayload = z.infer<typeof createdChannelSchema>;

/**
 * Delete responses are not uniform on the pinned server (SL-058).
 *
 * `signoz_delete_view` returns `{"status":"success"}` with no `data` at all,
 * `signoz_delete_notification_channel` returns `{"status":"success","id":"…"}`, and
 * `signoz_delete_dashboard` returns the plain sentence `dashboard deleted`. Validating a delete
 * against the single-resource envelope therefore fails a delete that in fact succeeded, which is
 * how a view *replacement* came to be reported as a create failure. The schema accepts whatever
 * shape arrives; what matters is that the call did not error.
 */
export const deletedResourceSchema = z
  .object({ status: z.string().optional(), id: z.string().optional() })
  .catchall(z.unknown());

export type DeletedResourcePayload = z.infer<typeof deletedResourceSchema>;

/** A get-by-id call returns the resource itself under `data`. */
export const singleResourceSchema = z.object({
  data: z.record(z.string(), z.unknown()),
});

/**
 * The structured error envelope observed on `isError: true`. `upstreamAuth` and friends are
 * present only for some failures, so everything except `code` is optional.
 */
export const errorEnvelopeSchema = z.object({
  code: z.string(),
  status: z.number().optional(),
  upstreamCode: z.string().optional(),
  upstreamMessage: z.string().optional(),
  upstreamType: z.string().optional(),
});

export type McpErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * The span fields FlightRules requires from a trace query. A row missing `span_id` cannot take
 * part in graph reconstruction, so its absence is a validation failure rather than a default.
 * Everything a contract rule reads is optional here and resolved in Phase 06, because "the
 * attribute was not set" and "the attribute was redacted" are both legitimate and must not be
 * confused with a broken response.
 */
export const spanRowSchema = z.object({
  span_id: z.string().min(1),
  trace_id: z.string().optional(),
  parent_span_id: z.string().optional(),
  name: z.string().optional(),
  kind_string: z.string().optional(),
  duration_nano: z.number().optional(),
  has_error: z.boolean().optional(),
  timestamp: z.string().optional(),
});

export type SpanRow = z.infer<typeof spanRowSchema>;
