import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

export type { AppliedMigration, MigrateResult, MigrationFile } from "./migrator.js";
export {
  loadMigrations,
  migrateDownOne,
  migrateUp,
  readApplied,
  splitMigrationSql,
} from "./migrator.js";

/** Absolute path to the committed migration directory, resolved from this package. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export interface ConnectOptions {
  readonly max?: number;
  readonly connectTimeoutSeconds?: number;
}

export function connect(databaseUrl: string, options: ConnectOptions = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    onnotice: () => {},
    transform: { undefined: null },
  });
}

export type { Sql };
