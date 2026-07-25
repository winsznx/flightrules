import { FlightRulesError } from "@flightrules/domain";

/**
 * PostgreSQL failures translated into the product's typed error vocabulary.
 *
 * A driver error carries the connection string in some failure modes and the offending row values
 * in others, so nothing from it is ever forwarded. Only the SQLSTATE class and the constraint name
 * cross the boundary, because a constraint name is something FlightRules chose and therefore
 * something it is safe to name back.
 */

/** SQLSTATE codes we act on. Anything else is an internal failure with no detail leaked. */
export const PG_CODES = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
  lockNotAvailable: "55P03",
  undefinedTable: "42P01",
  undefinedColumn: "42703",
} as const;

export interface PostgresFailure {
  readonly code: string;
  readonly constraint: string | null;
  readonly table: string | null;
}

export function asPostgresFailure(error: unknown): PostgresFailure | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; constraint_name?: unknown; table_name?: unknown };
  if (typeof candidate.code !== "string") return null;
  return {
    code: candidate.code,
    constraint: typeof candidate.constraint_name === "string" ? candidate.constraint_name : null,
    table: typeof candidate.table_name === "string" ? candidate.table_name : null,
  };
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const failure = asPostgresFailure(error);
  if (!failure || failure.code !== PG_CODES.uniqueViolation) return false;
  return constraint === undefined || failure.constraint === constraint;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return asPostgresFailure(error)?.code === PG_CODES.foreignKeyViolation;
}

export function isCheckViolation(error: unknown): boolean {
  return asPostgresFailure(error)?.code === PG_CODES.checkViolation;
}

/** True for failures a retry could plausibly resolve. */
export function isTransientFailure(error: unknown): boolean {
  const failure = asPostgresFailure(error);
  if (!failure) return false;
  return (
    failure.code === PG_CODES.serializationFailure ||
    failure.code === PG_CODES.deadlockDetected ||
    failure.code === PG_CODES.lockNotAvailable ||
    failure.code.startsWith("08") ||
    failure.code === "57P01" ||
    failure.code === "57P03"
  );
}

export class SchemaIncompatibleError extends FlightRulesError {
  constructor(expected: string, applied: readonly string[]) {
    super("CONFIG_INVALID", {
      message:
        "The database schema does not match the migrations this build requires. " +
        "Run `make db-migrate` before starting FlightRules.",
      details: { expectedMigration: expected, appliedMigrations: applied },
    });
    this.name = "SchemaIncompatibleError";
  }
}

/**
 * Converts a driver failure into a `FlightRulesError`, keeping only the constraint name.
 *
 * `CONFIG_INVALID` is the code for a schema that does not exist yet, because that is an operator
 * action rather than a request problem, and `EVALUATION_FAILED` is the deliberately uninformative
 * fallback for everything else.
 */
export function toDatabaseError(error: unknown): FlightRulesError {
  if (error instanceof FlightRulesError) return error;
  const failure = asPostgresFailure(error);
  if (!failure) {
    return new FlightRulesError("EVALUATION_FAILED", {
      message: "A database operation failed.",
    });
  }
  if (failure.code === PG_CODES.undefinedTable || failure.code === PG_CODES.undefinedColumn) {
    return new FlightRulesError("CONFIG_INVALID", {
      message:
        "The database schema is missing an object FlightRules requires. Run `make db-migrate`.",
      details: { sqlState: failure.code },
    });
  }
  return new FlightRulesError("EVALUATION_FAILED", {
    message: "A database operation failed.",
    details: {
      sqlState: failure.code,
      ...(failure.constraint === null ? {} : { constraint: failure.constraint }),
    },
  });
}
