import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

export type { JsonValue } from "./canonical.js";
export { canonicalHash, canonicalise, canonicalJson, canonicalObject } from "./canonical.js";
export type { PostgresFailure } from "./errors.js";
export {
  asPostgresFailure,
  isCheckViolation,
  isForeignKeyViolation,
  isTransientFailure,
  isUniqueViolation,
  PG_CODES,
  SchemaIncompatibleError,
  toDatabaseError,
} from "./errors.js";
export type {
  BaselineMiningInput,
  ContractProposalInput,
  DemoRunInput,
  EvaluationInput,
  SignozSyncInput,
} from "./job-inputs.js";
export {
  BaselineMiningInputSchema,
  ContractProposalInputSchema,
  DemoRunInputSchema,
  EvaluationInputSchema,
  SignozSyncInputSchema,
} from "./job-inputs.js";
export type { AppliedMigration, MigrateResult, MigrationFile } from "./migrator.js";
export {
  loadMigrations,
  migrateDownOne,
  migrateUp,
  readApplied,
  splitMigrationSql,
} from "./migrator.js";
export type { Page, PageRequest } from "./pagination.js";
export { decodeCursor, encodeCursor, PAGE_SIZE, toPage, toPageRequest } from "./pagination.js";
export { readCanonicalGraph } from "./read-canonical.js";
export * from "./repositories/agents.js";
export * from "./repositories/artifacts.js";
export * from "./repositories/audit.js";
export * from "./repositories/baselines.js";
export * from "./repositories/contracts.js";
export * from "./repositories/evaluations.js";
export * from "./repositories/jobs.js";
export * from "./repositories/projects.js";
export * from "./repositories/traces.js";
export type { SchemaCheck } from "./schema-version.js";
export { assertSchemaCompatible, checkSchema } from "./schema-version.js";
export type { Db } from "./sql.js";

/** Absolute path to the committed migration directory, resolved from this package. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export interface ConnectOptions {
  readonly max?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly applicationName?: string;
}

export function connect(databaseUrl: string, options: ConnectOptions = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 0,
    connection: options.applicationName ? { application_name: options.applicationName } : {},
    onnotice: () => {},
    transform: { undefined: null },
  });
}

export type { Sql };
