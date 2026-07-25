import type { ISql } from "postgres";

/**
 * The query surface every repository accepts.
 *
 * `postgres` types a pool as `Sql` and a transaction as `TransactionSql`, and neither extends the
 * other — they share the `ISql` interface that carries the tagged template and nothing else. Taking
 * `Db` means one repository function runs inside a transaction and outside it, which is what makes
 * "the audit row is written by the transaction that made the change" expressible without a second
 * copy of every query.
 */
export type Db = ISql;
