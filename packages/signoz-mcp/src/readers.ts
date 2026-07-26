import type { PayloadReader } from "./normalise.js";
import {
  type BuilderQueryPayload,
  type BuilderRow,
  builderQueryPayloadSchema,
  type CreatedChannelPayload,
  createdChannelSchema,
  createdResourceSchema,
  deletedResourceSchema,
  type FieldKeysPayload,
  type FieldValuesPayload,
  fieldKeysPayloadSchema,
  fieldValuesPayloadSchema,
  type ListPayload,
  listPayloadSchema,
  type MetricSeriesPayload,
  metricSeriesPayloadSchema,
  singleResourceSchema,
} from "./schemas.js";

/**
 * Payload readers pair a runtime schema with the two payload-specific questions the normaliser
 * cannot answer generically: how many rows came back, and where the SigNoz deep link is.
 */

/** Flattens the two nesting levels a builder-query response uses into a single row list. */
export function rowsOf(payload: BuilderQueryPayload): readonly BuilderRow[] {
  const results = payload.data.data.results ?? [];
  const rows: BuilderRow[] = [];
  for (const result of results) {
    for (const row of result.rows ?? []) rows.push(row);
  }
  return rows;
}

export const builderQueryReader: PayloadReader<typeof builderQueryPayloadSchema> = {
  schema: builderQueryPayloadSchema,
  countRows: (payload) => rowsOf(payload).length,
  // FR-003 requires the SigNoz link to be retained whenever the payload returns one.
  webUrlOf: (payload) => payload.data.webUrl,
};

/** Every observation in a metric response, flattened out of its five levels of nesting. */
export function metricPointsOf(payload: MetricSeriesPayload): readonly {
  readonly labels: Readonly<Record<string, string>>;
  readonly timestamp: number | null;
  readonly value: number | null;
}[] {
  const points: {
    labels: Record<string, string>;
    timestamp: number | null;
    value: number | null;
  }[] = [];

  for (const result of payload.data.data.results ?? []) {
    for (const aggregation of result.aggregations ?? []) {
      for (const series of aggregation.series ?? []) {
        const labels: Record<string, string> = {};
        for (const label of series.labels ?? []) {
          const name = label.key?.name;
          // A dimension the series does not carry comes back with an empty value. Recorded as such
          // rather than dropped, so "not grouped by this" stays distinguishable from "blank".
          if (typeof name === "string" && name.length > 0) {
            labels[name] = typeof label.value === "string" ? label.value.slice(0, 200) : "";
          }
        }
        for (const point of series.values ?? []) {
          points.push({
            labels,
            timestamp: typeof point.timestamp === "number" ? point.timestamp : null,
            value: typeof point.value === "number" ? point.value : null,
          });
        }
      }
    }
  }
  return points;
}

/**
 * The metric reader.
 *
 * `countRows` counts **observations**, not rows, so an answer carrying a real series is classified
 * as `SUCCESS_WITH_ROWS` rather than as empty. That single line is the difference between a metric
 * panel that shows the truth and one that reports "no series exists" about data that is there.
 */
export const metricSeriesReader: PayloadReader<typeof metricSeriesPayloadSchema> = {
  schema: metricSeriesPayloadSchema,
  countRows: (payload) => metricPointsOf(payload).length,
};

export const listReader: PayloadReader<typeof listPayloadSchema> = {
  schema: listPayloadSchema,
  countRows: (payload) => payload.data?.length ?? 0,
};

export const fieldKeysReader: PayloadReader<typeof fieldKeysPayloadSchema> = {
  schema: fieldKeysPayloadSchema,
  countRows: (payload) => Object.keys(payload.data.keys ?? {}).length,
};

/** The discovered field names, sorted so repeated discovery produces a stable record. */
export function fieldNamesOf(payload: FieldKeysPayload): readonly string[] {
  return Object.keys(payload.data.keys ?? {}).sort();
}

export const fieldValuesReader: PayloadReader<typeof fieldValuesPayloadSchema> = {
  schema: fieldValuesPayloadSchema,
  countRows: (payload) => fieldValuesOf(payload).length,
};

/** Every observed value of a field, as strings, sorted for a stable record. */
export function fieldValuesOf(payload: FieldValuesPayload): readonly string[] {
  const values = payload.data.values;
  if (values === null || values === undefined) return [];
  return [
    ...(values.stringValues ?? []),
    ...(values.numberValues ?? []).map(String),
    ...(values.boolValues ?? []).map(String),
  ].sort();
}

export const createdResourceReader: PayloadReader<typeof createdResourceSchema> = {
  schema: createdResourceSchema,
  // A create call returns exactly one resource; treating it as one row keeps a successful create
  // out of SUCCESS_EMPTY, which callers read as "nothing was returned".
  countRows: () => 1,
};

export const createdChannelReader: PayloadReader<typeof createdChannelSchema> = {
  schema: createdChannelSchema,
  countRows: () => 1,
};

/**
 * Whether the server's own test notification reached the destination.
 *
 * `undefined` means the server did not report a test at all, which is not the same as a failure
 * and must not be recorded as one.
 */
export function channelDeliveryOf(payload: CreatedChannelPayload): {
  readonly tested: boolean;
  readonly delivered: boolean | undefined;
} {
  const test = payload.test_notification;
  if (test === undefined) return { tested: false, delivered: undefined };
  return { tested: true, delivered: test.success ?? false };
}

export const deletedResourceReader: PayloadReader<typeof deletedResourceSchema> = {
  schema: deletedResourceSchema,
  // A delete that returned anything at all is one row; the payload carries nothing to count.
  countRows: () => 1,
};

export const singleResourceReader: PayloadReader<typeof singleResourceSchema> = {
  schema: singleResourceSchema,
  countRows: (payload) => (Object.keys(payload.data).length > 0 ? 1 : 0),
};

export function identifierOf(payload: { data: { id: string } | string }): string {
  return typeof payload.data === "string" ? payload.data : payload.data.id;
}

/** Items from a list envelope. `data` is nullable on an empty list. */
export function itemsOf(payload: ListPayload): readonly unknown[] {
  return payload.data ?? [];
}
