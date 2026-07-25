import process from "node:process";
import { connect, MIGRATIONS_DIR, migrateDownOne, migrateUp, readApplied } from "./index.js";

function requireDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    process.stderr.write("DATABASE_URL is not set.\n");
    process.exit(5);
  }
  return url;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? "up";
  const sql = connect(requireDatabaseUrl(), { max: 1 });

  try {
    switch (command) {
      case "up": {
        const result = await migrateUp(sql, MIGRATIONS_DIR);
        process.stdout.write(
          `applied: ${result.applied.length > 0 ? result.applied.join(", ") : "none"}\n` +
            `already applied: ${result.alreadyApplied.length}\n`,
        );
        return 0;
      }
      case "down": {
        const reverted = await migrateDownOne(sql, MIGRATIONS_DIR);
        process.stdout.write(reverted ? `reverted: ${reverted}\n` : "nothing to revert\n");
        return 0;
      }
      case "status": {
        const applied = await readApplied(sql);
        process.stdout.write(
          applied.length === 0
            ? "no migrations applied\n"
            : `${applied.map((row) => `${row.id}_${row.name}`).join("\n")}\n`,
        );
        return 0;
      }
      default:
        process.stderr.write(`Unknown command "${command}". Use up, down or status.\n`);
        return 5;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(4);
  },
);
