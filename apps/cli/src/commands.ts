import { EXIT_CODES, type ExitCode } from "@flightrules/contract-engine";
import { contractContentHash, parseContract } from "@flightrules/contract-schema";
import { FlightRulesError } from "@flightrules/domain";
import { z } from "zod";
import type { ParsedCommand } from "./args.js";
import { integerOptionOr, optionalString, requireString, waitFlag } from "./args.js";
import {
  type ApiClient,
  DependenciesSchema,
  EvaluationSchema,
  type Gate,
  GateSchema,
  JobAcceptedSchema,
  pageOf,
  ReadinessSchema,
  ViolationSchema,
} from "./client.js";
import type { Io } from "./output.js";
import { field, heading, progress, renderGate, renderGateSummary } from "./output.js";
import { resolveRelease, resolveTarget, waitForJob } from "./resolve.js";

/**
 * The six commands of PRD Phase 11 task 5.
 *
 * Each returns its exit code and its machine-readable result. Nothing calls `process.exit`: the
 * entry point owns the process, so every command is callable from a test and the exit-code contract
 * is asserted directly rather than by spawning a shell.
 *
 * A command never decides a release. `gate check` reads a decision the server computed from
 * persisted evidence and maps it through the one exit-code table; there is no branch here that can
 * produce a `0` the server did not.
 */

export interface CommandOutcome {
  readonly exitCode: ExitCode;
  readonly result: unknown;
  /** Human-readable report for stdout when `--json` was not given. */
  readonly report: string;
}

export interface CommandContext {
  readonly io: Io;
  readonly parsed: ParsedCommand;
  readonly client: ApiClient;
}

const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_ROOT_SPAN = "refund.request";

/* -------------------------------------------------------------------------- */
/* config verify                                                              */
/* -------------------------------------------------------------------------- */

export async function configVerify(context: CommandContext): Promise<CommandOutcome> {
  const { io, parsed, client } = context;
  progress(io, parsed.global.quiet, `verifying ${client.baseUrl}`);

  const readiness = await client.get("/health/ready", ReadinessSchema);
  const dependencies = await client.get("/health/dependencies", DependenciesSchema);

  const result = {
    apiUrl: client.baseUrl,
    api: readiness.status,
    database: dependencies.database.status,
    signoz: dependencies.signoz.status,
    missingSignozTools: dependencies.signoz.missingTools,
    schemaCompatible: readiness.schema.compatible,
    appliedMigrations: readiness.schema.applied,
    missingMigrations: readiness.schema.missing,
  };

  let report = heading("Configuration");
  report += field("API URL", client.baseUrl);
  report += field("API readiness", readiness.status);
  report += field("database", dependencies.database.status);
  report += field("schema compatible", String(readiness.schema.compatible));
  report += field("applied migrations", readiness.schema.applied.join(", ") || "none");
  report += field("SigNoz", dependencies.signoz.status);
  if (dependencies.signoz.missingTools.length > 0) {
    report += field("missing MCP tools", dependencies.signoz.missingTools.join(", "));
  }

  // SigNoz `degraded` is not a configuration failure: PRD section 15.1 allows it explicitly, and
  // read-only local pages keep working. A `down` database or an incompatible schema is.
  const healthy =
    readiness.status === "ready" &&
    dependencies.database.status === "up" &&
    readiness.schema.compatible;

  if (!healthy) {
    report += "\nFlightRules is not ready. Review the failed check and retry.\n";
    return { exitCode: EXIT_CODES.integrationError, result, report };
  }
  report += "\nFlightRules is configured and its dependencies are reachable.\n";
  return { exitCode: EXIT_CODES.pass, result, report };
}

/* -------------------------------------------------------------------------- */
/* contract validate <path>                                                   */
/* -------------------------------------------------------------------------- */

export async function contractValidate(context: CommandContext): Promise<CommandOutcome> {
  const { io, parsed } = context;
  const path = parsed.positional[0];
  if (path === undefined || path.trim().length === 0) {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: "contract validate requires a path to a contract document.",
    });
  }

  let source: string;
  try {
    source = await io.readFile(path);
  } catch {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: `The contract document at "${path}" could not be read.`,
      details: { path },
    });
  }

  const parsedContract = parseContract(source);
  if (!parsedContract.ok) {
    const errors = parsedContract.errors.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    }));
    let report = `${path}: invalid. ${errors.length} error(s).\n`;
    for (const issue of errors) {
      report += `  ${issue.path}  ${issue.code}  ${issue.message}\n`;
    }
    return {
      exitCode: EXIT_CODES.invalidConfiguration,
      result: { path, valid: false, errors },
      report,
    };
  }

  const contract = parsedContract.value.contract;
  const hash = contractContentHash(contract);
  const result = {
    path,
    valid: true,
    errors: [],
    contractId: contract.metadata.id,
    version: contract.metadata.version,
    environment: contract.metadata.environment,
    ruleCount: contract.spec.rules.length,
    approvedRoutes: contract.spec.approvedRoutes.length,
    zeroToleranceRuleIds: [...contract.spec.gate.zeroToleranceRuleIds].sort(),
    contentHash: hash,
  };

  let report = `${path}: valid.\n`;
  report += field("contract", `${contract.metadata.id} ${contract.metadata.version}`);
  report += field("environment", contract.metadata.environment);
  report += field("rules", String(contract.spec.rules.length));
  report += field("approved routes", String(contract.spec.approvedRoutes.length));
  report += field("zero-tolerance rules", result.zeroToleranceRuleIds.join(", ") || "none");
  report += field("content hash", hash);
  return { exitCode: EXIT_CODES.pass, result, report };
}

/* -------------------------------------------------------------------------- */
/* baseline capture                                                           */
/* -------------------------------------------------------------------------- */

export async function baselineCapture(context: CommandContext): Promise<CommandOutcome> {
  const { io, parsed, client } = context;
  const { options, global } = parsed;

  const target = await resolveTarget(
    client,
    requireString(options, io.env, "project", "FLIGHTRULES_PROJECT"),
    requireString(options, io.env, "agent", "FLIGHTRULES_AGENT"),
  );
  const releaseKey = requireString(options, io.env, "release", "FLIGHTRULES_RELEASE");
  const lookbackMinutes = integerOptionOr(
    options["lookback"],
    "lookback",
    1,
    60 * 24 * 30,
    DEFAULT_LOOKBACK_MINUTES,
  );
  const endMs = io.now().getTime();

  progress(io, global.quiet, `capturing a baseline for ${releaseKey}`);
  const accepted = await client.post(
    `/api/agents/${target.agentId}/baselines`,
    {
      releaseKey,
      environment: optionalString(options, io.env, "environment") ?? null,
      startMs: endMs - lookbackMinutes * 60_000,
      endMs,
      minimumRuns: integerOptionOr(options["minimum-runs"], "minimum-runs", 1, 5_000, 20),
      rootSpanName: optionalString(options, io.env, "root-span") ?? DEFAULT_ROOT_SPAN,
      maxTraces: integerOptionOr(options["max-traces"], "max-traces", 1, 5_000, 500),
    },
    JobAcceptedSchema,
  );

  if (!waitFlag(options)) {
    return {
      exitCode: EXIT_CODES.pass,
      result: { jobId: accepted.jobId, status: accepted.status, waited: false },
      report: field("baseline job", accepted.jobId),
    };
  }

  const outcome = await waitForJob(client, io, global.quiet, accepted.jobId, global.timeoutSeconds);
  const summary = (outcome.result ?? {}) as Record<string, unknown>;
  let report = heading("Baseline");
  report += field("job", accepted.jobId);
  for (const key of Object.keys(summary).sort()) {
    report += field(key, JSON.stringify(summary[key]));
  }
  return {
    exitCode: EXIT_CODES.pass,
    result: { jobId: accepted.jobId, status: outcome.status, ...summary },
    report,
  };
}

/* -------------------------------------------------------------------------- */
/* release evaluate                                                           */
/* -------------------------------------------------------------------------- */

export async function releaseEvaluate(context: CommandContext): Promise<CommandOutcome> {
  const { io, parsed, client } = context;
  const { options, global } = parsed;

  const target = await resolveTarget(
    client,
    requireString(options, io.env, "project", "FLIGHTRULES_PROJECT"),
    requireString(options, io.env, "agent", "FLIGHTRULES_AGENT"),
  );
  const releaseKey = requireString(options, io.env, "release", "FLIGHTRULES_RELEASE");

  const contractId = optionalString(options, io.env, "contract");
  const resolvedContractId =
    contractId ??
    (await activeContractId(
      client,
      target.agentId,
      optionalString(options, io.env, "environment"),
    ));

  const lookbackMinutes = integerOptionOr(
    options["lookback"],
    "lookback",
    1,
    60 * 24 * 30,
    DEFAULT_LOOKBACK_MINUTES,
  );
  const endMs = io.now().getTime();

  progress(io, global.quiet, `evaluating ${releaseKey} against ${resolvedContractId}`);
  const accepted = await client.post(
    `/api/agents/${target.agentId}/evaluations`,
    {
      contractId: resolvedContractId,
      releaseKey,
      ...(optionalString(options, io.env, "environment") === undefined
        ? {}
        : { environment: optionalString(options, io.env, "environment") }),
      scope: "release",
      rootSpanName: optionalString(options, io.env, "root-span") ?? DEFAULT_ROOT_SPAN,
      startMs: endMs - lookbackMinutes * 60_000,
      endMs,
      maxTraces: integerOptionOr(options["max-traces"], "max-traces", 1, 5_000, 500),
    },
    JobAcceptedSchema.extend({ evaluationId: z.string() }),
  );

  if (!waitFlag(options)) {
    return {
      exitCode: EXIT_CODES.pass,
      result: { jobId: accepted.jobId, evaluationId: accepted.evaluationId, waited: false },
      report: field("evaluation job", accepted.jobId),
    };
  }

  await waitForJob(client, io, global.quiet, accepted.jobId, global.timeoutSeconds);
  const evaluation = await client.get(
    `/api/evaluations/${accepted.evaluationId}`,
    EvaluationSchema,
  );
  const summary = (evaluation.summary ?? {}) as Record<string, unknown>;

  let report = heading("Evaluation");
  report += field("evaluation", evaluation.id);
  report += field("status", evaluation.status);
  for (const key of Object.keys(summary).sort()) {
    report += field(key, JSON.stringify(summary[key]));
  }
  report += "\nRun `flightrules gate check` for the release decision.\n";

  // A completed evaluation exits 0 whatever it found. Deciding is `gate check`'s job; conflating
  // the two would make "the evaluation ran" and "the release is safe" the same exit code.
  const exitCode =
    evaluation.status === "insufficient_data"
      ? EXIT_CODES.insufficientData
      : evaluation.status === "error"
        ? EXIT_CODES.integrationError
        : EXIT_CODES.pass;

  return {
    exitCode,
    result: {
      jobId: accepted.jobId,
      evaluationId: evaluation.id,
      status: evaluation.status,
      releaseId: evaluation.releaseId,
      summary,
    },
    report,
  };
}

async function activeContractId(
  client: ApiClient,
  agentId: string,
  environment: string | undefined,
): Promise<string> {
  const page = await client.get(
    `/api/agents/${agentId}/contracts`,
    pageOf(
      z.object({
        id: z.string(),
        status: z.string(),
        environment: z.string(),
        semanticVersion: z.string(),
      }),
    ),
    { limit: "100" },
  );
  const active = page.items.filter(
    (contract) =>
      contract.status === "active" &&
      (environment === undefined || contract.environment === environment),
  );
  const found = active[0];
  if (!found) {
    throw new FlightRulesError("CONTRACT_INVALID", {
      message:
        "This agent has no active contract, so there is nothing to evaluate the release against.",
      details: { agentId, environment: environment ?? null },
    });
  }
  return found.id;
}

/* -------------------------------------------------------------------------- */
/* gate check                                                                 */
/* -------------------------------------------------------------------------- */

export async function gateCheck(context: CommandContext): Promise<CommandOutcome> {
  const { io, parsed, client } = context;
  const { options, global } = parsed;

  const releaseId = await resolveReleaseId(context);
  progress(io, global.quiet, `reading the release gate for ${releaseId}`);

  const query: Record<string, string> = {};
  const contractId = optionalString(options, io.env, "contract");
  if (contractId !== undefined) query["contractId"] = contractId;
  const maxAge = optionalString(options, io.env, "max-age");
  if (maxAge !== undefined) query["maxAgeSeconds"] = maxAge;

  const gate = await client.get(`/api/releases/${releaseId}/gate`, GateSchema, query);

  const summaryFile =
    optionalString(options, io.env, "summary-file") ?? io.env["GITHUB_STEP_SUMMARY"];
  if (summaryFile !== undefined && summaryFile.length > 0) {
    await io.appendFile(summaryFile, renderGateSummary(gate));
    progress(io, global.quiet, `wrote a job summary to ${summaryFile}`);
  }

  // The exit code is the server's decision mapped through the one table. Asserting the server and
  // the CLI agree catches a schema drift that would otherwise silently change a pipeline's result.
  const exitCode = exitCodeOf(gate);
  if (gate.exitCode !== exitCode) {
    throw new FlightRulesError("EVALUATION_FAILED", {
      message:
        "The API and the CLI disagree about the exit code for this decision. No result is reported.",
      details: { apiExitCode: gate.exitCode, cliExitCode: exitCode, decision: gate.decision },
    });
  }

  return { exitCode, result: gate, report: renderGate(gate) };
}

function exitCodeOf(gate: Gate): ExitCode {
  switch (gate.decision) {
    case "pass":
      return EXIT_CODES.pass;
    case "fail":
      return EXIT_CODES.contractViolation;
    case "insufficient_data":
      return EXIT_CODES.insufficientData;
    case "error":
      return EXIT_CODES.integrationError;
  }
}

async function resolveReleaseId(context: CommandContext): Promise<string> {
  const { io, parsed, client } = context;
  const explicit = optionalString(parsed.options, io.env, "release-id");
  if (explicit !== undefined) return explicit;

  const target = await resolveTarget(
    client,
    requireString(parsed.options, io.env, "project", "FLIGHTRULES_PROJECT"),
    requireString(parsed.options, io.env, "agent", "FLIGHTRULES_AGENT"),
  );
  const release = await resolveRelease(
    client,
    target.agentId,
    requireString(parsed.options, io.env, "release", "FLIGHTRULES_RELEASE"),
    optionalString(parsed.options, io.env, "environment"),
  );
  return release.id;
}

/* -------------------------------------------------------------------------- */
/* evidence export                                                            */
/* -------------------------------------------------------------------------- */

export async function evidenceExport(context: CommandContext): Promise<CommandOutcome> {
  const { io, parsed, client } = context;
  const { options, global } = parsed;

  const releaseId = await resolveReleaseId(context);
  const gate = await client.get(`/api/releases/${releaseId}/gate`, GateSchema);

  let violations: unknown[] = [];
  if (options["include-violations"] === true) {
    const page = await client.get(
      `/api/projects/${gate.projectId}/violations`,
      pageOf(ViolationSchema),
      { limit: "100", releaseId: gate.releaseId },
    );
    violations = [...page.items];
  }

  const document = {
    schemaVersion: gate.schemaVersion,
    exportedAt: io.now().toISOString(),
    decision: gate.decision,
    decisionHash: gate.decisionHash,
    release: {
      id: gate.releaseId,
      key: gate.releaseKey,
      environment: gate.environment,
    },
    contract: {
      id: gate.contractId,
      key: gate.contractKey,
      version: gate.contractVersion,
      contentHash: gate.contractContentHash,
      state: gate.contractState,
    },
    evaluation: { id: gate.evaluationId, status: gate.evaluationStatus },
    counts: gate.counts,
    rates: gate.rates,
    changes: gate.changes,
    releaseRules: gate.releaseRules,
    findings: gate.findings,
    disclosures: gate.disclosures,
    evidence: gate.evidence,
    violations,
  };

  const out = optionalString(options, io.env, "out");
  const serialised = `${JSON.stringify(document, null, 2)}\n`;
  if (out !== undefined) {
    await io.writeFile(out, serialised);
    progress(io, global.quiet, `wrote ${serialised.length} bytes to ${out}`);
    return {
      exitCode: EXIT_CODES.pass,
      result: { path: out, bytes: serialised.length, decision: gate.decision },
      report: field("evidence written", out),
    };
  }

  return { exitCode: EXIT_CODES.pass, result: document, report: serialised };
}
