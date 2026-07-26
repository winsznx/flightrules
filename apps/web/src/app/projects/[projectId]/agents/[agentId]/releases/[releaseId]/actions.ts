"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiPost, isFailure } from "@/lib/api";
import { findAgent, findGate, findRelease } from "@/lib/load";
import { failureUrl, outcomeUrl } from "@/lib/outcome";

/**
 * Re-evaluation (PRD Phase 14 task 9, PRD section 8.11's `Re-run evaluation`).
 *
 * The action calls `POST /api/releases/:releaseId/re-evaluate`, which creates an evaluation row and
 * a job. It does **not** change the release's decision: the decision is read from the most recent
 * *completed* evaluation, so until the job finishes the page keeps showing the previous decision,
 * with the new job's progress beside it.
 *
 * That ordering is the whole point. PRD Phase 14 forbids updating the release result optimistically
 * and requires prior evaluation evidence to be preserved; both fall out of the gate being a read
 * over completed evaluations rather than a value this action writes.
 *
 * Duplicate submission is safe: the evaluation's idempotency key is derived from the contract, its
 * content hash, the release, the scope and the window, so a second identical request returns the
 * same job.
 */

const JobAccepted = z.object({
  jobId: z.string(),
  status: z.string(),
  created: z.boolean(),
  evaluationId: z.string(),
});

/** Minutes of history a re-evaluation looks over. The same default the CLI's `--lookback` uses. */
const LOOKBACK_MINUTES = 360;

export async function reEvaluateRelease(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const releaseId = String(formData.get("releaseId") ?? "");
  const here = `/projects/${projectId}/agents/${agentId}/releases/${releaseId}`;

  // The contract to evaluate against is the one the release's current decision was taken under, read
  // from the server rather than carried in the form, so a stale page cannot re-evaluate against a
  // contract that has since been superseded.
  const [release, gate, agent] = await Promise.all([
    findRelease(releaseId),
    findGate(releaseId),
    findAgent(agentId),
  ]);

  if (isFailure(release)) redirect(failureUrl(here, "Re-run evaluation", release));
  if (isFailure(agent)) redirect(failureUrl(here, "Re-run evaluation", agent));
  if (isFailure(gate)) {
    redirect(
      outcomeUrl(here, {
        kind: "failed",
        action: "Re-run evaluation",
        code: gate.code,
        detail:
          "This release has no completed evaluation to re-run. Evaluate it against an active contract first.",
      }),
    );
  }

  const rootSpanName =
    typeof agent.data.rootSpanMatcher["name"] === "string"
      ? agent.data.rootSpanMatcher["name"]
      : "";
  if (rootSpanName.length === 0) {
    redirect(
      outcomeUrl(here, {
        kind: "failed",
        action: "Re-run evaluation",
        code: "AGENT_MATCHER_INVALID",
        detail: "This agent declares no root span name, so no evaluation window can be selected.",
      }),
    );
  }

  const endMs = Date.now();
  const submitted = await apiPost(
    `/api/releases/${releaseId}/re-evaluate`,
    {
      contractId: gate.data.contractId,
      environment: release.data.environment,
      scope: "release",
      rootSpanName,
      startMs: endMs - LOOKBACK_MINUTES * 60_000,
      endMs,
    },
    JobAccepted,
  );

  if (isFailure(submitted)) {
    redirect(failureUrl(here, "Re-run evaluation", submitted));
  }

  revalidatePath(here);
  redirect(
    outcomeUrl(
      here,
      { kind: "done", action: submitted.data.created ? "Re-run evaluation" : "Resume evaluation" },
      { job: submitted.data.jobId },
    ),
  );
}
