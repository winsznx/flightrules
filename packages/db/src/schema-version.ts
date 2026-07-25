import { SchemaIncompatibleError } from "./errors.js";
import { loadMigrations, readApplied } from "./migrator.js";
import type { Db } from "./sql.js";

/**
 * The schema an application build requires.
 *
 * An application never migrates on startup. It reads the ledger and refuses to become ready
 * against a database that is missing a migration it was built against, because a half-migrated
 * database produces failures that look like product bugs. Newer applied migrations are tolerated:
 * that is a rolling deployment, not a fault.
 */
export interface SchemaCheck {
  readonly compatible: boolean;
  readonly required: readonly string[];
  readonly applied: readonly string[];
  readonly missing: readonly string[];
}

export async function checkSchema(sql: Db, migrationsDir: string): Promise<SchemaCheck> {
  const required = (await loadMigrations(migrationsDir)).map((migration) => migration.id);
  const applied = (await readApplied(sql)).map((row) => row.id);
  const appliedSet = new Set(applied);
  const missing = required.filter((id) => !appliedSet.has(id));
  return { compatible: missing.length === 0, required, applied, missing };
}

export async function assertSchemaCompatible(sql: Db, migrationsDir: string): Promise<void> {
  const check = await checkSchema(sql, migrationsDir);
  if (check.compatible) return;
  throw new SchemaIncompatibleError(check.missing.join(", "), check.applied);
}
