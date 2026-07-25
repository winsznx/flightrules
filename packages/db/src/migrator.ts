import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";

export interface MigrationFile {
  readonly id: string;
  readonly name: string;
  readonly upSql: string;
  readonly downSql: string;
  readonly checksum: string;
}

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const DOWN_MARKER = "-- migrate:down";
const UP_MARKER = "-- migrate:up";

/**
 * Migrations are plain SQL files holding both directions, separated by markers, so a migration
 * can always be reverted without a second file drifting out of sync with the first.
 */
export function splitMigrationSql(source: string, fileName: string): { up: string; down: string } {
  const upIndex = source.indexOf(UP_MARKER);
  const downIndex = source.indexOf(DOWN_MARKER);

  if (upIndex === -1) throw new Error(`${fileName} is missing the "${UP_MARKER}" marker`);
  if (downIndex === -1) throw new Error(`${fileName} is missing the "${DOWN_MARKER}" marker`);
  if (downIndex < upIndex) throw new Error(`${fileName} declares "down" before "up"`);

  const up = source.slice(upIndex + UP_MARKER.length, downIndex).trim();
  const down = source.slice(downIndex + DOWN_MARKER.length).trim();

  if (up.length === 0) throw new Error(`${fileName} has an empty "up" section`);
  if (down.length === 0) throw new Error(`${fileName} has an empty "down" section`);

  return { up, down };
}

export async function loadMigrations(directory: string): Promise<readonly MigrationFile[]> {
  const entries = await readdir(directory);
  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();

  const migrations: MigrationFile[] = [];
  const seenIds = new Set<string>();

  for (const fileName of sqlFiles) {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (!match) {
      throw new Error(`Migration file name "${fileName}" must match NNNN_snake_case_name.sql`);
    }
    const id = match[1] as string;
    const name = match[2] as string;
    if (seenIds.has(id)) throw new Error(`Duplicate migration id ${id}`);
    seenIds.add(id);

    const source = await readFile(path.join(directory, fileName), "utf8");
    const { up, down } = splitMigrationSql(source, fileName);

    migrations.push({
      id,
      name,
      upSql: up,
      downSql: down,
      checksum: createHash("sha256").update(source).digest("hex"),
    });
  }

  return migrations;
}

const LEDGER_DDL = `
create table if not exists schema_migrations (
  id text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
)`;

export interface AppliedMigration {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
}

export async function readApplied(sql: Sql): Promise<readonly AppliedMigration[]> {
  await sql.unsafe(LEDGER_DDL);
  const rows = await sql<
    { id: string; name: string; checksum: string }[]
  >`select id, name, checksum from schema_migrations order by id asc`;
  return rows.map((row) => ({ id: row.id, name: row.name, checksum: row.checksum }));
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/**
 * Applies every pending migration inside one transaction per migration. A checksum mismatch on an
 * already-applied migration is a hard failure: it means committed history was edited, and
 * silently continuing would make the deployed schema unreproducible.
 */
export async function migrateUp(sql: Sql, directory: string): Promise<MigrateResult> {
  const migrations = await loadMigrations(directory);
  const applied = await readApplied(sql);
  const appliedById = new Map(applied.map((row) => [row.id, row]));

  const newlyApplied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    const existing = appliedById.get(migration.id);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.id}_${migration.name} was modified after it was applied. ` +
            "Create a new migration instead of editing history.",
        );
      }
      alreadyApplied.push(migration.id);
      continue;
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(migration.upSql);
      await tx`insert into schema_migrations (id, name, checksum)
               values (${migration.id}, ${migration.name}, ${migration.checksum})`;
    });
    newlyApplied.push(migration.id);
  }

  return { applied: newlyApplied, alreadyApplied };
}

/** Reverts the most recently applied migration. Used by the migration-rollback test. */
export async function migrateDownOne(sql: Sql, directory: string): Promise<string | null> {
  const migrations = await loadMigrations(directory);
  const applied = await readApplied(sql);
  const last = applied.at(-1);
  if (!last) return null;

  const migration = migrations.find((candidate) => candidate.id === last.id);
  if (!migration) {
    throw new Error(`Applied migration ${last.id} has no matching file; cannot revert safely.`);
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(migration.downSql);
    await tx`delete from schema_migrations where id = ${migration.id}`;
  });

  return migration.id;
}
