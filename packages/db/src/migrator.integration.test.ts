import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connect,
  MIGRATIONS_DIR,
  migrateDownOne,
  migrateUp,
  readApplied,
  type Sql,
} from "./index.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set for database integration tests. Run `make up` first, or run " +
      "`make test` for the unit project which does not require PostgreSQL.",
  );
}

let sql: Sql;

beforeAll(async () => {
  sql = connect(databaseUrl, { max: 2 });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe("migrations against a real PostgreSQL database", () => {
  it("applies every migration from an empty database", async () => {
    const result = await migrateUp(sql, MIGRATIONS_DIR);

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.alreadyApplied).toEqual([]);

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`;
    const names = tables.map((row) => row.table_name);

    expect(names).toEqual(
      expect.arrayContaining([
        "audit_events",
        "projects",
        "schema_migrations",
        "signoz_connections",
      ]),
    );
  });

  it("is idempotent when run a second time", async () => {
    const result = await migrateUp(sql, MIGRATIONS_DIR);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied.length).toBeGreaterThan(0);
  });

  it("generates sortable time-ordered identifiers", async () => {
    const rows = await sql<{ a: string; b: string }[]>`
      select flightrules_uuid_v7()::text as a, flightrules_uuid_v7()::text as b`;
    const row = rows[0];
    expect(row).toBeDefined();
    // Version 7 nibble sits at the start of the third group.
    expect(row?.a[14]).toBe("7");
    expect(row?.a).not.toBe(row?.b);
    expect((row?.a ?? "") < (row?.b ?? "")).toBe(true);
  });

  it("maintains updated_at through the touch trigger", async () => {
    const inserted = await sql<{ id: string; updated_at: Date }[]>`
      insert into projects (name, slug) values ('Demo Commerce', 'demo-commerce')
      returning id, updated_at`;
    const before = inserted[0];
    expect(before).toBeDefined();

    const updated = await sql<{ updated_at: Date }[]>`
      update projects set description = 'changed' where id = ${before?.id ?? ""}
      returning updated_at`;

    expect(updated[0]?.updated_at.getTime()).toBeGreaterThanOrEqual(
      before?.updated_at.getTime() ?? 0,
    );
  });

  it("rejects a duplicate project slug", async () => {
    await expect(
      sql`insert into projects (name, slug) values ('Duplicate', 'demo-commerce')`,
    ).rejects.toThrow(/projects_slug_unique|duplicate key/i);
  });

  it("rejects a slug that is not lower-kebab-case", async () => {
    await expect(
      sql`insert into projects (name, slug) values ('Bad Slug', 'Not A Slug')`,
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("cascades audit events when a project is deleted", async () => {
    const created = await sql<{ id: string }[]>`
      insert into projects (name, slug) values ('Cascade', 'cascade-project') returning id`;
    const projectId = created[0]?.id ?? "";

    await sql`insert into audit_events (project_id, actor_type, event_type, entity_type, entity_id)
              values (${projectId}, 'system', 'project.created', 'project', ${projectId})`;

    await sql`delete from projects where id = ${projectId}`;

    const remaining = await sql<{ count: string }[]>`
      select count(*)::text as count from audit_events where project_id = ${projectId}`;
    expect(remaining[0]?.count).toBe("0");
  });

  it("reverts the most recent migration and can reapply it", async () => {
    const appliedBefore = await readApplied(sql);
    const reverted = await migrateDownOne(sql, MIGRATIONS_DIR);
    expect(reverted).toBe(appliedBefore.at(-1)?.id);

    const appliedAfter = await readApplied(sql);
    expect(appliedAfter.length).toBe(appliedBefore.length - 1);

    const reapplied = await migrateUp(sql, MIGRATIONS_DIR);
    expect(reapplied.applied).toEqual([reverted]);
  });
});
