import {
  type OperationContext,
  SigNozMcpClient,
  SigNozOperations,
  StreamableToolCaller,
} from "@flightrules/signoz-mcp";
import type { WorkerConfig } from "./config.js";

/**
 * The worker's SigNoz boundary.
 *
 * A session per job rather than a long-lived client. A worker is idle most of the time, and a
 * connection held open across idle periods is a connection that fails on the next job for reasons
 * unrelated to the job. Opening one per job also means a job's MCP failure is attributable to that
 * job, which is what makes the retry classification meaningful.
 */

export interface SignozSession {
  readonly operations: SigNozOperations;
  close(): Promise<void>;
}

export type SignozFactory = () => Promise<SignozSession>;

export const WORKER_OPERATION_CONTEXT: OperationContext = {
  searchContext:
    "FlightRules worker: retrieve complete known-good and canary traces for baseline mining and contract evaluation",
};

export function liveSignozFactory(config: WorkerConfig): SignozFactory {
  return async () => {
    const caller = new StreamableToolCaller({
      url: config.signozMcpUrl,
      apiKey: config.signozApiKey,
      clientName: "flightrules-worker",
    });
    const client = new SigNozMcpClient({ caller, timeoutMs: config.mcpRequestTimeoutMs });
    // PRD section 16.4: the tool list is discovered before use, so a missing tool is a capability
    // failure rather than an unexplained call error halfway through a mining run.
    await client.discoverCapabilities();
    return {
      operations: new SigNozOperations(client),
      close: () => client.close(),
    };
  };
}
