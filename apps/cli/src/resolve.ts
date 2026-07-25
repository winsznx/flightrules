import { FlightRulesError } from "@flightrules/domain";
import {
  AgentSchema,
  type ApiClient,
  JobSchema,
  ProjectSchema,
  pageOf,
  ReleaseSchema,
} from "./client.js";
import type { Io } from "./output.js";
import { progress } from "./output.js";

/**
 * Turning human-friendly names into identifiers, and waiting on jobs.
 *
 * A CLI that demanded UUIDs would be unusable in a workflow file, and one that guessed would gate a
 * release against the wrong agent. Every lookup here is exact — a slug or key must match exactly —
 * and an ambiguous or absent match is a typed `NOT_FOUND`, never a nearest guess.
 */

export interface Target {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly agentId: string;
  readonly agentKey: string;
}

const PAGE_LIMIT = "100";

export async function resolveProject(
  client: ApiClient,
  slug: string,
): Promise<{ readonly id: string; readonly slug: string; readonly defaultEnvironment: string }> {
  const page = await client.get("/api/projects", pageOf(ProjectSchema), { limit: PAGE_LIMIT });
  const found = page.items.find((project) => project.slug === slug);
  if (!found) {
    throw new FlightRulesError("NOT_FOUND", {
      message: `No project has the slug "${slug}".`,
      details: { slug, available: page.items.map((project) => project.slug).sort() },
    });
  }
  return { id: found.id, slug: found.slug, defaultEnvironment: found.defaultEnvironment };
}

export async function resolveTarget(
  client: ApiClient,
  projectSlug: string,
  agentKey: string,
): Promise<Target> {
  const project = await resolveProject(client, projectSlug);
  const page = await client.get(`/api/projects/${project.id}/agents`, pageOf(AgentSchema), {
    limit: PAGE_LIMIT,
  });
  const agent = page.items.find((candidate) => candidate.agentKey === agentKey);
  if (!agent) {
    throw new FlightRulesError("NOT_FOUND", {
      message: `Project "${projectSlug}" has no agent with the key "${agentKey}".`,
      details: { agentKey, available: page.items.map((candidate) => candidate.agentKey).sort() },
    });
  }
  return {
    projectId: project.id,
    projectSlug: project.slug,
    agentId: agent.id,
    agentKey: agent.agentKey,
  };
}

/**
 * The release row for a release key.
 *
 * A release exists only once telemetry carrying its discriminator has been observed and evaluated,
 * so "not found" here is a real answer: nothing has been evaluated for that release yet. It is
 * reported as `RELEASE_INSUFFICIENT_DATA`, which exits `3` — not as a generic failure, and never
 * as a pass.
 */
export async function resolveRelease(
  client: ApiClient,
  agentId: string,
  releaseKey: string,
  environment: string | undefined,
): Promise<{ readonly id: string; readonly releaseKey: string; readonly environment: string }> {
  const page = await client.get(`/api/agents/${agentId}/releases`, pageOf(ReleaseSchema), {
    limit: PAGE_LIMIT,
  });
  const matches = page.items.filter(
    (release) =>
      release.releaseKey === releaseKey &&
      (environment === undefined || release.environment === environment),
  );
  const found = matches[0];
  if (!found) {
    throw new FlightRulesError("RELEASE_INSUFFICIENT_DATA", {
      message: `No release "${releaseKey}" has been observed for this agent yet. Run an evaluation first.`,
      details: { releaseKey, environment: environment ?? null },
    });
  }
  return { id: found.id, releaseKey: found.releaseKey, environment: found.environment };
}

export interface JobOutcome {
  readonly id: string;
  readonly status: string;
  readonly result: unknown;
  readonly error: unknown;
}

/**
 * Polls a job to a terminal state.
 *
 * The deadline is wall-clock and is enforced by the caller's `--timeout`, so a stuck worker fails
 * the command rather than hanging a pipeline. A timeout is `RELEASE_INSUFFICIENT_DATA` when nothing
 * was produced and `EVALUATION_FAILED` when the job itself failed, so the two are distinguishable
 * by exit code — `3` versus `4`.
 */
export async function waitForJob(
  client: ApiClient,
  io: Io,
  quiet: boolean,
  jobId: string,
  timeoutSeconds: number,
): Promise<JobOutcome> {
  const deadline = io.now().getTime() + timeoutSeconds * 1_000;
  let lastStage: string | null = null;

  for (;;) {
    const job = await client.get(`/api/jobs/${jobId}`, JobSchema);
    if (job.progressStage !== null && job.progressStage !== lastStage) {
      lastStage = job.progressStage;
      progress(io, quiet, `  ${job.progressStage}`);
    }
    if (job.status === "succeeded") {
      return { id: job.id, status: job.status, result: job.result, error: null };
    }
    if (job.status === "failed" || job.status === "cancelled") {
      const failure = job.error as { readonly code?: unknown; readonly message?: unknown } | null;
      throw new FlightRulesError(
        typeof failure?.code === "string" && failure.code === "BASELINE_INSUFFICIENT_RUNS"
          ? "BASELINE_INSUFFICIENT_RUNS"
          : "EVALUATION_FAILED",
        {
          message:
            typeof failure?.message === "string"
              ? failure.message
              : `Job ${jobId} ${job.status} without a reported reason.`,
          details: { jobId, status: job.status },
        },
      );
    }
    if (io.now().getTime() >= deadline) {
      throw new FlightRulesError("RELEASE_INSUFFICIENT_DATA", {
        message: `Job ${jobId} did not finish within ${timeoutSeconds} seconds. No decision was produced.`,
        details: { jobId, status: job.status, timeoutSeconds },
      });
    }
    await io.sleep(1_000);
  }
}
