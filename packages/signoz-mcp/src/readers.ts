import type { PayloadReader } from "./normalise.js";
import {
  type BuilderQueryPayload,
  type BuilderRow,
  builderQueryPayloadSchema,
  createdResourceSchema,
  type FieldKeysPayload,
  type FieldValuesPayload,
  fieldKeysPayloadSchema,
  fieldValuesPayloadSchema,
  type ListPayload,
  listPayloadSchema,
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
