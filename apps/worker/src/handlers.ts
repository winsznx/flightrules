import {
  applyRouteDecisions,
  type BaselineVersion,
  discoverRuns,
  type EligibleRun,
  emitContractYaml,
  fetchTraces,
  mineBaseline,
  proposeContract,
  resolveSelection,
  signozTraceSource,
} from "@flightrules/baseline-miner";
import {
  type ApprovedRoute,
  countDuplicateSideEffects,
  EVALUATOR_VERSION,
  evaluateRun,
  sideEffectingRuleIds,
} from "@flightrules/contract-engine";
import { canonicalContract, parseContract } from "@flightrules/contract-schema";
import type { JobType } from "@flightrules/db";
import {
  BaselineMiningInputSchema,
  ContractProposalInputSchema,
  completeEvaluation,
  createContract,
  type Db,
  DemoRunInputSchema,
  EvaluationInputSchema,
  findBaseline,
  findContract,
  findProject,
  findRouteFamilyByFingerprint,
  GRAPH_SCHEMA_VERSION,
  observeRelease,
  persistBaseline,
  persistRunEvaluation,
  recordAudit,
  SignozSyncInputSchema,
  startEvaluation,
  upsertTraceGraph,
  upsertTraceRun,
} from "@flightrules/db";
import { FlightRulesError } from "@flightrules/domain";
import {
  AGENT,
  FLIGHT_RULES,
  type FlightRulesMetrics,
  recordFlightRulesSpan,
  SPAN_NAMES,
  withFlightRulesSpan,
} from "@flightrules/telemetry";
import {
  buildTraceGraph,
  canonicaliseGraph,
  featuresOfGraph,
  type TraceGraph,
} from "@flightrules/trace-graph";
import {
  ArtifactSynchroniser,
  persistArtifactWrites,
  readRegisteredArtifacts,
  synchroniseArtifacts,
} from "./artifact-sync.js";
import type { CommitFn, JobContext, JobHandler } from "./runner.js";
import { CancelledError, TerminalJobError } from "./runner.js";
import { type SignozFactory, WORKER_OPERATION_CONTEXT } from "./signoz.js";

/**
 * The four job handlers.
 *
 * None of them contains a deterministic algorithm. Mining is `mineBaseline`, proposal is
 * `proposeContract`, evaluation is `evaluateRun`, validation is `parseContract`. A handler's job is
 * to fetch what those functions need, report progress, and hand the runner a commit function.
 */

export interface HandlerDependencies {
  readonly signoz: SignozFactory;
  readonly metrics?: FlightRulesMetrics | undefined;
  /** Injected so the demo handler can be tested without a running demo agent. */
  readonly fetch?: typeof globalThis.fetch;
}

async function ensureRunning(context: JobContext): Promise<void> {
  if (await context.cancelled()) throw new CancelledError();
}

function parseInput<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: unknown,
  what: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    throw new TerminalJobError(
      "VALIDATION_FAILED",
      `The stored ${what} job input does not match the current contract and cannot be run.`,
    );
  }
  return result.data;
}

/**
 * The run's own start and duration, taken from its root span.
 *
 * A trace has no timing of its own; the root span is the run. Nanoseconds are narrowed to whole
 * milliseconds because SigNoz returns the timestamp column at millisecond precision anyway (SL-044),
 * so anything finer would be invented.
 */
function rootTiming(graph: TraceGraph): { startedAtMs: number; durationMs: number } {
  const root = graph.nodes.find((node) => node.spanId === graph.rootSpanId) ?? graph.nodes[0];
  if (!root) return { startedAtMs: 0, durationMs: 0 };
  return {
    startedAtMs: Number(root.startTimeUnixNano / 1_000_000n),
    durationMs: Number(root.durationNano / 1_000_000n),
  };
}

/** Persists a run and its canonical graph. Idempotent, so a retried job rewrites rather than duplicates. */
async function persistRun(
  tx: Db,
  input: {
    agentId: string;
    releaseId: string | null;
    traceId: string;
    runId: string | null;
    webUrl: string | null;
    startedAtMs: number;
    durationMs: number;
    graph: TraceGraph;
    fingerprint: string;
    warnings: readonly string[];
  },
): Promise<string> {
  const canonical = canonicaliseGraph(input.graph);
  const traceRun = await upsertTraceRun(tx, {
    agentId: input.agentId,
    releaseId: input.releaseId,
    traceId: input.traceId,
    runId: input.runId,
    signozWebUrl: input.webUrl,
    rootSpanId: input.graph.rootSpanId,
    startedAt: new Date(input.startedAtMs),
    completedAt: new Date(input.startedAtMs + input.durationMs),
    durationMs: input.durationMs,
    status: input.graph.quality === "complete" ? "ok" : "unknown",
    qualityStatus: input.graph.quality,
    summary: {
      nodes: input.graph.nodes.length,
      edges: input.graph.edges.length,
      warnings: [...input.warnings].sort(),
    },
  });
  await upsertTraceGraph(tx, {
    traceRunId: traceRun.id,
    normaliserVersion: input.graph.normaliserVersion,
    normaliserConfigHash: input.graph.normaliserConfigHash,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    fingerprint: input.fingerprint,
    canonical,
    featureSet: featuresOfGraph(input.graph),
    qualityWarnings: [...input.warnings].sort(),
  });
  return traceRun.id;
}

// ---------------------------------------------------------------------------
// baseline_mining
// ---------------------------------------------------------------------------

function baselineMiningHandler(dependencies: HandlerDependencies): JobHandler {
  return async (context: JobContext): Promise<CommitFn> => {
    const input = parseInput(BaselineMiningInputSchema, context.job.input, "baseline mining");
    await ensureRunning(context);

    const session = await dependencies.signoz();
    let mined: Awaited<ReturnType<typeof mineBaseline>>;
    try {
      // Progress writes are serialised behind one chain: `onProgress` is synchronous, and firing
      // independent promises would let two stages race and land out of order. The monotonic guard
      // in the repository would drop the loser, which is correct but would lose an event.
      let chain: Promise<void> = Promise.resolve();
      mined = await mineBaseline({
        selection: {
          projectKey: input.projectKey,
          agentKey: input.agentKey,
          releaseId: input.releaseKey,
          environment: input.environment,
          startMs: input.startMs,
          endMs: input.endMs,
          minimumRuns: input.minimumRuns,
          rootSpanName: input.rootSpanName,
          successfulRunsOnly: input.successfulRunsOnly,
          excludeMissingRootSpan: input.excludeMissingRootSpan,
          rareThreshold: input.rareThreshold,
          maxTraces: input.maxTraces,
          representativesPerFamily: input.representativesPerFamily,
          maxSpansPerTrace: input.maxSpansPerTrace,
        },
        source: signozTraceSource(session.operations, WORKER_OPERATION_CONTEXT),
        onProgress: (progress) => {
          chain = chain.then(() => context.progress(progress.stage, progress.detail));
        },
      });
      await chain;
    } finally {
      await session.close().catch(() => {});
    }

    if (!mined.ok) {
      const first = mined.errors[0];
      dependencies.metrics?.recordTraceFetchFailure(
        {
          projectId: input.projectId,
          agentId: input.agentId,
          projectSlug: input.projectKey,
          agentKey: input.agentKey,
        },
        first?.code ?? "unknown",
      );
      throw new TerminalJobError(
        first?.code === "DISCOVERY_FAILED" ? "TRACE_QUERY_FAILED" : "BASELINE_INSUFFICIENT_RUNS",
        mined.errors.map((error) => `${error.code}: ${error.message}`).join("; "),
      );
    }

    await ensureRunning(context);
    const baseline = mined.value.baseline;
    const runs = [...mined.value.runsByFingerprint.values()].flat();

    return async (tx: Db) => {
      const release = await observeRelease(tx, {
        agentId: input.agentId,
        releaseKey: input.releaseKey,
        environment: input.environment ?? "unknown",
        observedAt: new Date(baseline.sourceTimeEndMs),
      });

      const stored = await persistBaseline(tx, {
        agentId: input.agentId,
        releaseId: release.id,
        jobId: context.job.id,
        baseline,
        selection: {
          projectKey: input.projectKey,
          agentKey: input.agentKey,
          releaseId: input.releaseKey,
          environment: input.environment,
          startMs: input.startMs,
          endMs: input.endMs,
          minimumRuns: input.minimumRuns,
          rootSpanName: input.rootSpanName,
          successfulRunsOnly: input.successfulRunsOnly,
          excludeMissingRootSpan: input.excludeMissingRootSpan,
          rareThreshold: input.rareThreshold,
          maxTraces: input.maxTraces,
          representativesPerFamily: input.representativesPerFamily,
          maxSpansPerTrace: input.maxSpansPerTrace,
        },
      });

      for (const run of runs) {
        await persistRun(tx, {
          agentId: input.agentId,
          releaseId: release.id,
          traceId: run.traceId,
          runId: run.runId,
          webUrl: run.webUrl,
          startedAtMs: run.startedAtMs,
          durationMs: run.durationMs,
          graph: run.graph,
          fingerprint: run.fingerprint,
          warnings: run.warnings,
        });
      }

      await recordAudit(tx, {
        projectId: input.projectId,
        actorType: "system",
        eventType: "baseline.created",
        entityType: "baseline_version",
        entityId: stored.id,
        details: {
          baselineIdentifier: stored.baselineIdentifier,
          status: stored.status,
          families: stored.families.length,
          jobId: context.job.id,
        },
      });

      return {
        baselineId: stored.id,
        baselineIdentifier: stored.baselineIdentifier,
        selectionHash: stored.selectionHash,
        status: stored.status,
        routeFamilies: stored.families.length,
        eligibleRuns: baseline.counts.eligibleRuns,
        excludedTraces: baseline.counts.excludedTraces,
        truncated: baseline.retrieval.truncated,
      };
    };
  };
}

// ---------------------------------------------------------------------------
// contract_proposal
// ---------------------------------------------------------------------------

/**
 * Re-mines the stored selection and asserts it produced the same dataset.
 *
 * PRD section 14.5 is explicit that raw traces are not stored and are refetched from SigNoz when
 * needed, and rule proposal needs the runs themselves, not just the canonical projection. Mining is
 * deterministic in the selection, so re-mining the same window is not a second algorithm — but the
 * *dataset* can change if a trace has aged out of SigNoz, and a proposal founded on a different
 * dataset from the one the reviewer approved would be a different proposal wearing the same name.
 * So the identity and the family fingerprints are compared, and a difference is a typed failure.
 */
async function reMineForProposal(
  context: JobContext,
  dependencies: HandlerDependencies,
  selection: Parameters<typeof mineBaseline>[0]["selection"],
  expected: { baselineIdentifier: string; fingerprints: readonly string[] },
): Promise<{
  baseline: BaselineVersion;
  runsByFingerprint: ReadonlyMap<string, readonly EligibleRun[]>;
}> {
  const session = await dependencies.signoz();
  try {
    let chain: Promise<void> = Promise.resolve();
    const mined = await mineBaseline({
      selection,
      source: signozTraceSource(session.operations, WORKER_OPERATION_CONTEXT),
      onProgress: (progress) => {
        chain = chain.then(() => context.progress(progress.stage, progress.detail));
      },
    });
    await chain;
    if (!mined.ok) {
      throw new TerminalJobError(
        "TRACE_FETCH_FAILED",
        mined.errors.map((error) => `${error.code}: ${error.message}`).join("; "),
      );
    }
    const baseline = mined.value.baseline;
    if (baseline.id !== expected.baselineIdentifier) {
      throw new TerminalJobError(
        "BASELINE_INSUFFICIENT_RUNS",
        "The stored selection no longer derives the baseline it was recorded under.",
      );
    }
    const observed = baseline.families.map((family) => family.fingerprint).sort();
    const wanted = [...expected.fingerprints].sort();
    if (
      observed.length !== wanted.length ||
      observed.some((value, index) => value !== wanted[index])
    ) {
      throw new TerminalJobError(
        "TRACE_INCOMPLETE",
        "The traces this baseline was mined from are no longer retrievable identically from SigNoz, " +
          "so a proposal would not describe the dataset that was reviewed.",
      );
    }
    return { baseline, runsByFingerprint: mined.value.runsByFingerprint };
  } finally {
    await session.close().catch(() => {});
  }
}

function contractProposalHandler(dependencies: HandlerDependencies): JobHandler {
  return async (context: JobContext): Promise<CommitFn> => {
    const input = parseInput(ContractProposalInputSchema, context.job.input, "contract proposal");
    await ensureRunning(context);

    const stored = await findBaseline(context.sql, input.baselineVersionId);
    if (!stored) {
      throw new TerminalJobError(
        "NOT_FOUND",
        "The baseline this proposal was requested for is gone.",
      );
    }
    const selection = stored.selection as Parameters<typeof resolveSelection>[0];

    const remined = await reMineForProposal(context, dependencies, selection, {
      baselineIdentifier: stored.baselineIdentifier,
      fingerprints: stored.families.map((family) => family.fingerprint),
    });

    await ensureRunning(context);
    // The reviewer's decisions, replayed through the miner's own transition function, which is the
    // authority on which decisions are legal and on what the baseline's status becomes.
    const decided = applyRouteDecisions(
      remined.baseline,
      input.decisions.map((decision) => ({
        fingerprint: decision.fingerprint,
        decision:
          decision.status === "approved"
            ? ("approve" as const)
            : decision.status === "rejected"
              ? ("reject" as const)
              : decision.status === "optional"
                ? ("mark_optional" as const)
                : ("exclude_fixture_error" as const),
      })),
    );
    if (!decided.ok) {
      throw new TerminalJobError(
        "BASELINE_INSUFFICIENT_RUNS",
        decided.errors.map((error) => `${error.code}: ${error.message}`).join("; "),
      );
    }

    await context.progress(
      "proposing_contract_rules",
      "generating rules from the approved families",
    );

    const proposed = proposeContract({
      baseline: decided.baseline,
      runsByFingerprint: remined.runsByFingerprint,
      options: {
        createdAt: input.createdAt,
        environment: input.environment,
        workflowName: input.workflowName,
      },
    });
    if (!proposed.ok) {
      throw new TerminalJobError(
        "CONTRACT_INVALID",
        proposed.errors.map((error) => `${error.code}: ${error.message}`).join("; "),
      );
    }

    const emitted = emitContractYaml(proposed.proposal);
    if (!emitted.ok) {
      throw new TerminalJobError(
        "CONTRACT_INVALID",
        `${emitted.error.code}: ${emitted.error.message}`,
      );
    }

    // The emitted document goes back through the public parser before it is stored, so what lands
    // in the row is provably a document the Phase 07 validator accepts.
    const reparsed = parseContract(emitted.yaml);
    if (!reparsed.ok) {
      throw new TerminalJobError(
        "CONTRACT_INVALID",
        "The generated contract did not survive its own round trip through the validator.",
      );
    }

    const evidenceByRuleId = new Map<string, unknown>(
      proposed.proposal.rules.map((entry) => [entry.rule.id, entry.evidence]),
    );

    return async (tx: Db) => {
      const created = await createContract(tx, {
        agentId: input.agentId,
        baselineVersionId: stored.id,
        jobId: context.job.id,
        environment: input.environment,
        source: "mined",
        contract: reparsed.value.contract,
        canonical: canonicalContract(reparsed.value.contract),
        contentHash: reparsed.value.contentHash,
        yamlText: emitted.yaml,
        evidenceByRuleId,
      });
      await recordAudit(tx, {
        projectId: input.projectId,
        actorType: "system",
        eventType: "contract.created",
        entityType: "contract",
        entityId: created.contract.id,
        details: {
          source: "mined",
          contentHash: created.contract.contentHash,
          rules: created.rules.length,
          baselineVersionId: stored.id,
          jobId: context.job.id,
        },
      });
      return {
        contractId: created.contract.id,
        contentHash: created.contract.contentHash,
        // FR-018 and ADR-0007 decision 14: a proposal is a draft. Nothing here activates anything.
        status: created.contract.status,
        rules: created.rules.length,
        zeroToleranceRules: proposed.proposal.contract.spec.gate.zeroToleranceRuleIds.length,
        disclosures: proposed.proposal.disclosures.length,
      };
    };
  };
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

function evaluationHandler(dependencies: HandlerDependencies): JobHandler {
  return async (context: JobContext): Promise<CommitFn> => {
    const input = parseInput(EvaluationInputSchema, context.job.input, "evaluation");
    await ensureRunning(context);

    const contractRow = await findContract(context.sql, input.contractId);
    if (!contractRow) {
      throw new TerminalJobError(
        "NOT_FOUND",
        "The contract this evaluation names no longer exists.",
      );
    }
    const parsed = parseContract(contractRow.yamlText);
    if (!parsed.ok) {
      throw new TerminalJobError(
        "CONTRACT_INVALID",
        "The stored contract document no longer validates, so no run may be judged against it.",
      );
    }

    // Approved routes come from the baseline the contract was proposed from. Without them the
    // similarity score has nothing to compare against, so a contract with no baseline evaluates
    // route membership by fingerprint alone — which is what the `approved_routes` rule already does.
    const approvedRoutes: ApprovedRoute[] = [];
    if (contractRow.baselineVersionId !== null) {
      const baseline = await findBaseline(context.sql, contractRow.baselineVersionId);
      for (const family of baseline?.families ?? []) {
        if (family.status === "approved") {
          approvedRoutes.push({ fingerprint: family.fingerprint, canonical: family.canonical });
        }
      }
    }

    const selection = resolveSelection({
      projectKey: input.projectKey,
      agentKey: input.agentKey,
      releaseId: input.releaseKey,
      environment: input.environment,
      startMs: input.startMs,
      endMs: input.endMs,
      minimumRuns: 1,
      rootSpanName: input.rootSpanName,
      successfulRunsOnly: false,
      excludeMissingRootSpan: false,
      maxTraces: input.maxTraces,
      maxSpansPerTrace: input.maxSpansPerTrace,
    });

    const session = await dependencies.signoz();
    let retrieved: Awaited<ReturnType<typeof fetchTraces>>;
    try {
      await context.progress(
        "discovering_traces",
        `finding ${input.releaseKey} runs in the window`,
      );
      const discovered = await discoverRuns(
        session.operations,
        selection,
        WORKER_OPERATION_CONTEXT,
      );
      if (!discovered.ok) {
        throw new FlightRulesError("TRACE_QUERY_FAILED", { message: discovered.error.message });
      }
      const unique = [...new Set(discovered.dataset.traceIds)];
      await context.progress(
        "fetching_span_trees",
        `fetching ${unique.length} complete span trees`,
      );
      retrieved = await fetchTraces(
        session.operations,
        unique,
        selection,
        WORKER_OPERATION_CONTEXT,
      );
    } finally {
      await session.close().catch(() => {});
    }

    await ensureRunning(context);
    await context.progress(
      "normalising_routes",
      `reconstructing ${retrieved.traces.length} graphs`,
    );

    const evaluated = retrieved.traces.map((trace) => {
      const graph = buildTraceGraph(trace.rows, { rootSelector: input.rootSpanName });
      return {
        trace,
        graph,
        run: evaluateRun({ graph, contract: parsed.value.contract, approvedRoutes }),
      };
    });

    await context.progress("evaluating_runs", `evaluated ${evaluated.length} runs`);

    if (evaluated.length === 0) {
      // PRD section 20.1: the gate never passes after an internal error, and an empty dataset is
      // not a pass either. `insufficient_data` is the honest outcome and it is recorded, not thrown.
      return async (tx: Db) => {
        await startEvaluation(tx, input.evaluationId);
        const completed = await completeEvaluation(tx, input.evaluationId, "insufficient_data", {
          runs: 0,
          reason: "No completed runs were found for this release in the requested window.",
        });
        await recordAudit(tx, {
          projectId: input.projectId,
          actorType: "system",
          eventType: "evaluation.completed",
          entityType: "evaluation",
          entityId: input.evaluationId,
          details: { status: completed?.status ?? "insufficient_data", runs: 0 },
        });
        return {
          evaluationId: input.evaluationId,
          status: "insufficient_data",
          runs: 0,
          violations: 0,
        };
      };
    }

    // Computed once for the whole release: which rules pin themselves to a side-effecting step.
    const sideEffectingRules = sideEffectingRuleIds(parsed.value.contract);

    return async (tx: Db) => {
      await startEvaluation(tx, input.evaluationId);
      const release = await observeRelease(tx, {
        agentId: input.agentId,
        releaseKey: input.releaseKey,
        environment: input.environment,
        observedAt: new Date(input.endMs),
      });

      // Built here rather than above, because the release identifier only exists once the release
      // has been observed — and it is the identifier, not the key, that the API and the saved
      // views select on.
      const dimensions = {
        projectId: input.projectId,
        agentId: input.agentId,
        projectSlug: input.projectKey,
        agentKey: input.agentKey,
        releaseId: release.id,
        releaseKey: input.releaseKey,
        scope: input.scope,
      };

      let violations = 0;
      let zeroTolerance = 0;
      let duplicateSideEffects = 0;
      let failed = 0;
      let errored = 0;
      let insufficient = 0;

      for (const entry of evaluated) {
        const evaluation = entry.run.evaluation;
        const traceRunId = await persistRun(tx, {
          agentId: input.agentId,
          releaseId: release.id,
          traceId: evaluation.traceId,
          runId: null,
          webUrl: entry.trace.webUrl,
          startedAtMs: rootTiming(entry.graph).startedAtMs,
          durationMs: rootTiming(entry.graph).durationMs,
          graph: entry.graph,
          fingerprint: evaluation.routeFingerprint,
          warnings: entry.graph.warnings.map((warning) => warning.kind),
        });

        const nearest =
          evaluation.nearestApprovedFingerprint === null || contractRow.baselineVersionId === null
            ? null
            : ((
                await findRouteFamilyByFingerprint(
                  tx,
                  contractRow.baselineVersionId,
                  evaluation.nearestApprovedFingerprint,
                )
              )?.id ?? null);

        await persistRunEvaluation(tx, input.evaluationId, {
          traceRunId,
          nearestRouteFamilyId: nearest,
          evaluated: entry.run,
          signozWebUrl: entry.trace.webUrl,
        });

        violations += evaluation.counts.violations;
        zeroTolerance += evaluation.counts.zeroToleranceViolations;
        if (evaluation.status === "fail") failed += 1;
        if (evaluation.status === "error") errored += 1;
        if (evaluation.status === "insufficient_data") insufficient += 1;

        if (!evaluation.routeApproved) dependencies.metrics?.recordUnknownRoute(dimensions);
        dependencies.metrics?.recordRouteSimilarity(
          dimensions,
          Number(evaluation.similarity.decimal),
        );
        for (const violation of evaluation.violations) {
          dependencies.metrics?.recordViolation(dimensions, violation.ruleType, violation.severity);
        }
        const duplicates = countDuplicateSideEffects(sideEffectingRules, evaluation.violations);
        if (duplicates > 0) {
          dependencies.metrics?.recordDuplicateSideEffect(dimensions, duplicates);
        }
        duplicateSideEffects += duplicates;

        // PRD section 17.3. The evaluator's own verdict has to be in SigNoz for the Phase 10
        // "violating runs" view and "latest violating traces" panel to select on something real.
        recordFlightRulesSpan(SPAN_NAMES.evaluateRun, {
          [FLIGHT_RULES.projectId]: input.projectId,
          [FLIGHT_RULES.agentId]: input.agentId,
          [FLIGHT_RULES.contractId]: input.contractId,
          [FLIGHT_RULES.contractVersion]: contractRow.semanticVersion,
          [FLIGHT_RULES.releaseId]: release.id,
          [FLIGHT_RULES.evaluationId]: input.evaluationId,
          [FLIGHT_RULES.evaluationStatus]: evaluation.status,
          [FLIGHT_RULES.violationCount]: evaluation.counts.violations,
          [FLIGHT_RULES.routeFingerprint]: evaluation.routeFingerprint,
          [FLIGHT_RULES.routeSimilarity]: Number(evaluation.similarity.decimal),
          [FLIGHT_RULES.evaluatedTraceId]: evaluation.traceId,
          [FLIGHT_RULES.evaluatorVersion]: EVALUATOR_VERSION,
          [AGENT.releaseId]: input.releaseKey,
          "flight_rules.route.approved": evaluation.routeApproved,
          "flight_rules.violation.zero_tolerance_count": evaluation.counts.zeroToleranceViolations,
          "flight_rules.duplicate_side_effect.count": duplicates,
        });
      }

      const status =
        errored > 0
          ? ("error" as const)
          : failed > 0
            ? ("fail" as const)
            : insufficient === evaluated.length
              ? ("insufficient_data" as const)
              : ("pass" as const);

      const summary = {
        runs: evaluated.length,
        failedRuns: failed,
        erroredRuns: errored,
        insufficientRuns: insufficient,
        violations,
        zeroToleranceViolations: zeroTolerance,
        duplicateSideEffects,
        contractContentHash: contractRow.contentHash,
        evaluatorVersion: EVALUATOR_VERSION,
      };
      await completeEvaluation(tx, input.evaluationId, status, summary);
      await recordAudit(tx, {
        projectId: input.projectId,
        actorType: "system",
        eventType: "evaluation.completed",
        entityType: "evaluation",
        entityId: input.evaluationId,
        details: { status, ...summary },
      });

      dependencies.metrics?.recordEvaluation(dimensions, status, input.endMs - input.startMs);
      recordFlightRulesSpan(SPAN_NAMES.evaluateRelease, {
        [FLIGHT_RULES.projectId]: input.projectId,
        [FLIGHT_RULES.agentId]: input.agentId,
        [FLIGHT_RULES.contractId]: input.contractId,
        [FLIGHT_RULES.contractVersion]: contractRow.semanticVersion,
        [FLIGHT_RULES.releaseId]: release.id,
        [FLIGHT_RULES.evaluationId]: input.evaluationId,
        [FLIGHT_RULES.evaluationStatus]: status,
        [FLIGHT_RULES.violationCount]: violations,
        [FLIGHT_RULES.evaluatorVersion]: EVALUATOR_VERSION,
        [AGENT.releaseId]: input.releaseKey,
        "flight_rules.run.count": evaluated.length,
        "flight_rules.violation.zero_tolerance_count": zeroTolerance,
        "flight_rules.duplicate_side_effect.count": duplicateSideEffects,
      });

      return {
        evaluationId: input.evaluationId,
        status,
        runs: evaluated.length,
        violations,
        zeroToleranceViolations: zeroTolerance,
      };
    };
  };
}

// ---------------------------------------------------------------------------
// demo_run
// ---------------------------------------------------------------------------

function demoRunHandler(dependencies: HandlerDependencies): JobHandler {
  return async (context: JobContext): Promise<CommitFn> => {
    if (!context.config.demoMode) {
      throw new TerminalJobError("DEMO_DISABLED", "This worker is not running in demo mode.");
    }
    const input = parseInput(DemoRunInputSchema, context.job.input, "demo run");
    await ensureRunning(context);
    await context.progress("running_demo", `running ${input.runs} ${input.releaseKey} run(s)`);

    const request = dependencies.fetch ?? globalThis.fetch;
    const response = await request(`${context.config.demoAgentUrl}/agent/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        releaseId: input.releaseKey,
        orderId: input.orderId,
        runs: input.runs,
      }),
    });
    if (!response.ok) {
      // The demo agent is a local service; an outage is environmental, so this is retryable.
      throw new FlightRulesError("EVALUATION_FAILED", {
        message: `The demo agent returned HTTP ${response.status}.`,
      });
    }
    const payload = (await response.json()) as { completedRuns?: unknown; runIds?: unknown };
    const completedRuns = typeof payload.completedRuns === "number" ? payload.completedRuns : 0;

    return async (tx: Db) => {
      const project = context.job.projectId ? await findProject(tx, context.job.projectId) : null;
      if (project && context.job.entityId) {
        await observeRelease(tx, {
          agentId: context.job.entityId,
          releaseKey: input.releaseKey,
          environment: project.defaultEnvironment,
          observedAt: context.now(),
        });
      }
      return { releaseKey: input.releaseKey, completedRuns, requestedRuns: input.runs };
    };
  };
}

// ---------------------------------------------------------------------------
// signoz_sync
// ---------------------------------------------------------------------------

/**
 * Compiles the active contract into SigNoz artefacts and verifies every one of them.
 *
 * Like every other handler, this one contains no algorithm: compilation, planning and comparison
 * are `@flightrules/artifact-compiler`, and the MCP conversation is `artifact-sync.ts`. What lives
 * here is the job's shape — read the contract, refuse if it is not approved or active, run the
 * sync, and hand the runner a commit function that writes the register inside the transaction that
 * marks the job succeeded.
 */
function signozSyncHandler(dependencies: HandlerDependencies): JobHandler {
  return async (context: JobContext): Promise<CommitFn> => {
    const input = parseInput(SignozSyncInputSchema, context.job.input, "SigNoz sync");
    await ensureRunning(context);

    const contract = await findContract(context.sql, input.contractId);
    if (!contract) {
      throw new TerminalJobError("NOT_FOUND", "The contract to synchronise no longer exists.");
    }
    if (contract.status !== "approved" && contract.status !== "active") {
      throw new TerminalJobError(
        "STATE_TRANSITION_INVALID",
        `A ${contract.status} contract cannot be compiled into SigNoz artefacts.`,
      );
    }
    if (contract.contentHash !== input.contractContentHash) {
      // The contract changed after the job was queued. Compiling the new one would produce
      // artefacts nobody asked for, so this fails rather than silently doing something else.
      throw new TerminalJobError(
        "CONTRACT_CONFLICT",
        "The contract changed after this synchronisation was queued.",
      );
    }

    await context.progress("compiling", "compiling managed SigNoz artefacts");

    const session = await dependencies.signoz();
    try {
      const registered = await readRegisteredArtifacts(context.sql, input.projectId);
      const { result, writes } = await withFlightRulesSpan(
        SPAN_NAMES.compileSignozArtifacts,
        {
          [FLIGHT_RULES.projectId]: input.projectId,
          [FLIGHT_RULES.agentId]: input.agentId,
          [FLIGHT_RULES.contractId]: input.contractId,
          [FLIGHT_RULES.contractVersion]: input.contractVersion,
        },
        async () =>
          synchroniseArtifacts(
            {
              projectId: input.projectId,
              agentId: input.agentId,
              contractId: input.contractId,
              projectSlug: input.projectSlug,
              agentKey: input.agentKey,
              contractVersion: input.contractVersion,
              rootSpanName: input.rootSpanName,
              violationThreshold: input.violationThreshold,
              webhookUrl: context.config.alertWebhookUrl,
              signozBaseUrl: context.config.signozUrl,
              attempt: context.job.attempt,
            },
            registered,
            {
              synchroniser: new ArtifactSynchroniser(session.operations),
              now: context.now,
              progress: (stage, message) => context.progress(stage, message),
            },
          ),
      );

      for (const outcome of result.outcomes) {
        dependencies.metrics?.recordArtifactSync(
          {
            projectId: input.projectId,
            agentId: input.agentId,
            projectSlug: input.projectSlug,
            agentKey: input.agentKey,
          },
          outcome.artifactType,
          outcome.operation,
        );
      }

      // The register is written in its own transaction, before the commit function, precisely so
      // that a verification failure still leaves the evidence behind: the commit transaction is
      // rolled back when the job fails, and a rolled-back mismatch record is no record at all.
      await context.sql.begin((tx) => persistArtifactWrites(tx, writes));

      return async (tx: Db) => {
        await recordAudit(tx, {
          projectId: input.projectId,
          actorType: "system",
          eventType: "artifact.synced",
          entityType: "contract",
          entityId: input.contractId,
          details: {
            planHash: result.planHash,
            created: result.created,
            updated: result.updated,
            unchanged: result.unchanged,
            conflicts: result.conflicts,
            failed: result.failed,
            stale: [...result.stale],
          },
        });

        if (result.failed > 0) {
          // Operating-contract rule 13: a read-back mismatch fails the job. The register has
          // already recorded which artefact and which field, so the failure is diagnosable.
          const failures = result.outcomes.filter((outcome) => outcome.operation === "failed");
          throw new FlightRulesError("ARTIFACT_VERIFY_FAILED", {
            // The names are in the message as well as the details, because a job row stores the
            // message and an operator reading it should not have to open the register to learn
            // which artefact failed.
            message: `SigNoz artefacts did not match their intended specification: ${failures
              .map(
                (outcome) =>
                  `${outcome.managedName} [${(outcome.verification?.mismatchedFields ?? []).join(", ") || (outcome.reason ?? "unknown")}]`,
              )
              .join("; ")}`,
            details: {
              failed: failures.map((outcome) => ({
                managedName: outcome.managedName,
                mismatchedFields: outcome.verification?.mismatchedFields ?? [],
                reason: outcome.reason ?? null,
              })),
            },
          });
        }

        return {
          planHash: result.planHash,
          created: result.created,
          updated: result.updated,
          unchanged: result.unchanged,
          conflicts: result.conflicts,
          stale: [...result.stale],
          channel: { ...result.channel },
          artifacts: result.outcomes.map((outcome) => ({
            managedName: outcome.managedName,
            artifactType: outcome.artifactType,
            operation: outcome.operation,
            status: outcome.status,
            signozResourceId: outcome.resourceId,
            signozWebUrl: outcome.webUrl,
          })),
        };
      };
    } finally {
      await session.close().catch(() => {});
    }
  };
}

export function createHandlers(
  dependencies: HandlerDependencies,
): Readonly<Record<JobType, JobHandler>> {
  return {
    baseline_mining: baselineMiningHandler(dependencies),
    contract_proposal: contractProposalHandler(dependencies),
    evaluation: evaluationHandler(dependencies),
    demo_run: demoRunHandler(dependencies),
    signoz_sync: signozSyncHandler(dependencies),
  };
}
