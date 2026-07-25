import { z } from "zod";

/**
 * The job input contract.
 *
 * One definition, shared by the API that writes `jobs.input_json` and the worker that reads it.
 * It lives beside the jobs repository because the row *is* the contract: a shape declared in the
 * API and re-declared in the worker would be two descriptions of one column, free to disagree
 * across a deployment where one side has been updated and the other has not.
 *
 * The worker parses every input through these schemas before acting, so a row written by an older
 * build, or edited by hand, fails as a typed job failure rather than as an exception halfway
 * through a mining run.
 */

const positiveInt = (max: number) => z.number().int().min(1).max(max);

/** PRD section 8.7's controls, plus the operational bounds `resolveSelection` needs. */
export const BaselineMiningInputSchema = z.object({
  agentId: z.string(),
  projectId: z.string(),
  projectKey: z.string().min(1).max(128),
  agentKey: z.string().min(1).max(128),
  releaseKey: z.string().min(1).max(200),
  environment: z.string().min(1).max(120).nullable(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  minimumRuns: positiveInt(5_000),
  rootSpanName: z.string().min(1).max(200),
  successfulRunsOnly: z.boolean(),
  excludeMissingRootSpan: z.boolean(),
  rareThreshold: z.number().min(0).max(1),
  maxTraces: positiveInt(5_000),
  representativesPerFamily: positiveInt(50),
  maxSpansPerTrace: positiveInt(100_000),
});
export type BaselineMiningInput = z.infer<typeof BaselineMiningInputSchema>;

/**
 * A proposal is founded on the *reviewed* baseline, so the decisions are carried in the input
 * rather than read at execution time. A reviewer who changes a decision after submitting produces
 * a different idempotency key and therefore a different job, instead of silently changing what a
 * queued job will propose.
 */
export const ContractProposalInputSchema = z.object({
  baselineVersionId: z.string(),
  agentId: z.string(),
  projectId: z.string(),
  environment: z.string().min(1).max(120),
  workflowName: z.string().min(1).max(200),
  createdAt: z.string().min(1).max(40),
  contractName: z.string().min(1).max(200),
  semanticVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  decisions: z
    .array(
      z.object({
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        status: z.enum(["approved", "rejected", "optional", "excluded_fixture_error"]),
      }),
    )
    .min(1)
    .max(1_000),
});
export type ContractProposalInput = z.infer<typeof ContractProposalInputSchema>;

export const EvaluationInputSchema = z.object({
  agentId: z.string(),
  projectId: z.string(),
  contractId: z.string(),
  evaluationId: z.string(),
  projectKey: z.string().min(1).max(128),
  agentKey: z.string().min(1).max(128),
  releaseKey: z.string().min(1).max(200),
  environment: z.string().min(1).max(120),
  scope: z.enum(["run", "release"]),
  rootSpanName: z.string().min(1).max(200),
  startMs: z.number().int(),
  endMs: z.number().int(),
  maxTraces: positiveInt(5_000),
  maxSpansPerTrace: positiveInt(100_000),
});
export type EvaluationInput = z.infer<typeof EvaluationInputSchema>;

export const DemoRunInputSchema = z.object({
  releaseKey: z.enum(["refund-agent-v1", "refund-agent-v2"]),
  orderId: z.string().min(1).max(64),
  runs: positiveInt(200),
  runKey: z.string().min(1).max(120),
});
export type DemoRunInput = z.infer<typeof DemoRunInputSchema>;
