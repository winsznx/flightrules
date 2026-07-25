import type { Sql } from "@flightrules/db";
import type { FlightRulesMetrics } from "@flightrules/telemetry";
import type { ApiConfig } from "./config.js";
import type { SignozGateway } from "./signoz.js";

/**
 * Everything a route handler is allowed to reach.
 *
 * Passed explicitly rather than imported, so a test builds an API over a disposable database and a
 * stub SigNoz without touching a module-level singleton, and so "what can this handler do" is
 * answerable from one type.
 */
export interface AppContext {
  readonly sql: Sql;
  readonly config: ApiConfig;
  readonly migrationsDir: string;
  /** Injected so a test can freeze time without stubbing a global. */
  readonly now: () => Date;
  /** A fresh SigNoz gateway per use; the caller closes it. */
  readonly gateway: () => SignozGateway;
  readonly metrics?: FlightRulesMetrics | undefined;
}
