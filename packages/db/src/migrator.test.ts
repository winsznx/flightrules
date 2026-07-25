import { describe, expect, it } from "vitest";
import { loadMigrations, MIGRATIONS_DIR, splitMigrationSql } from "./index.js";

describe("migration file parsing", () => {
  it("splits a migration into its up and down sections", () => {
    const { up, down } = splitMigrationSql(
      "-- migrate:up\ncreate table t (id int);\n-- migrate:down\ndrop table t;\n",
      "0001_test.sql",
    );
    expect(up).toBe("create table t (id int);");
    expect(down).toBe("drop table t;");
  });

  it("rejects a migration with no down section marker", () => {
    expect(() => splitMigrationSql("-- migrate:up\nselect 1;\n", "0001_test.sql")).toThrow(
      /missing the "-- migrate:down" marker/,
    );
  });

  it("rejects a migration with no up section marker", () => {
    expect(() => splitMigrationSql("-- migrate:down\nselect 1;\n", "0001_test.sql")).toThrow(
      /missing the "-- migrate:up" marker/,
    );
  });

  it("rejects a migration whose down section is empty", () => {
    expect(() =>
      splitMigrationSql("-- migrate:up\nselect 1;\n-- migrate:down\n", "0001_test.sql"),
    ).toThrow(/empty "down" section/);
  });

  it("rejects a migration that declares down before up", () => {
    expect(() =>
      splitMigrationSql("-- migrate:down\ndrop t;\n-- migrate:up\ncreate t;\n", "0001_test.sql"),
    ).toThrow(/declares "down" before "up"/);
  });
});

describe("committed migrations", () => {
  it("loads every committed migration with both directions and a checksum", async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);

    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations) {
      expect(migration.id).toMatch(/^\d{4}$/);
      expect(migration.upSql.length).toBeGreaterThan(0);
      expect(migration.downSql.length).toBeGreaterThan(0);
      expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("orders migrations by identifier so replay is deterministic", async () => {
    const ids = (await loadMigrations(MIGRATIONS_DIR)).map((migration) => migration.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it("assigns a unique identifier to every migration", async () => {
    const ids = (await loadMigrations(MIGRATIONS_DIR)).map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("produces a stable checksum for unchanged content", async () => {
    const first = await loadMigrations(MIGRATIONS_DIR);
    const second = await loadMigrations(MIGRATIONS_DIR);
    expect(first.map((m) => m.checksum)).toEqual(second.map((m) => m.checksum));
  });
});
