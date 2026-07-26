"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiPost, isFailure } from "@/lib/api";
import { findAgent } from "@/lib/load";
import { failureUrl, outcomeUrl } from "@/lib/outcome";

/**
 * Baseline capture, as a Server Action (PRD Phase 13 task 1).
 *
 * The form posts here. This module runs on the server, calls `POST /api/agents/:agentId/baselines`
 * through the `server-only` API client, and redirects to the same page carrying the job identifier.
 * From that point the page renders the job's persisted progress on every server render, so a
 * reload, an API restart or a closed tab all resume correctly.
 *
 * Nothing is validated here that the API does not also validate. What is checked here is what the
 * *form* can get wrong — a non-numeric field, an inverted window — so the user sees the field that
 * is wrong instead of a generic rejection.
 */

const JobAccepted = z.object({
  jobId: z.string(),
  status: z.string(),
  created: z.boolean(),
  idempotencyKey: z.string(),
});

const FormSchema = z.object({
  releaseKey: z.string().trim().min(1).max(200),
  environment: z.string().trim().max(120),
  lookbackMinutes: z.coerce.number().int().min(1).max(525_600),
  minimumRuns: z.coerce.number().int().min(1).max(5_000),
  rareThreshold: z.coerce.number().min(0).max(1),
  maxTraces: z.coerce.number().int().min(1).max(5_000),
  successfulRunsOnly: z.enum(["on"]).optional(),
  excludeMissingRootSpan: z.enum(["on"]).optional(),
});

export async function analyseBaseline(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const base = `/projects/${projectId}/agents/${agentId}/baselines/new`;

  const parsed = FormSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "form";
    redirect(
      outcomeUrl(base, {
        kind: "failed",
        action: "Analyse baseline",
        code: "VALIDATION_FAILED",
        detail: `The ${field} field is not a value FlightRules can use.`,
      }),
    );
  }

  // The agent's root span selector is the agent's, not the form's. A user cannot mine a different
  // workflow by editing a hidden field.
  const agent = await findAgent(agentId);
  if (isFailure(agent)) {
    redirect(failureUrl(base, "Analyse baseline", agent));
  }
  const rootSpanName =
    typeof agent.data.rootSpanMatcher["name"] === "string"
      ? agent.data.rootSpanMatcher["name"]
      : "";
  if (rootSpanName.length === 0) {
    redirect(
      outcomeUrl(base, {
        kind: "failed",
        action: "Analyse baseline",
        code: "AGENT_MATCHER_INVALID",
        detail: "This agent declares no root span name, so a baseline window cannot be selected.",
      }),
    );
  }

  const endMs = Date.now();
  const startMs = endMs - parsed.data.lookbackMinutes * 60_000;

  const submitted = await apiPost(
    `/api/agents/${agentId}/baselines`,
    {
      releaseKey: parsed.data.releaseKey,
      environment: parsed.data.environment.length === 0 ? null : parsed.data.environment,
      startMs,
      endMs,
      minimumRuns: parsed.data.minimumRuns,
      rootSpanName,
      successfulRunsOnly: parsed.data.successfulRunsOnly === "on",
      excludeMissingRootSpan: parsed.data.excludeMissingRootSpan === "on",
      rareThreshold: parsed.data.rareThreshold,
      maxTraces: parsed.data.maxTraces,
    },
    JobAccepted,
  );

  if (isFailure(submitted)) {
    redirect(failureUrl(base, "Analyse baseline", submitted));
  }

  revalidatePath(base);
  // `created: false` means the API matched an identical selection to a job already submitted. That
  // is the idempotency guarantee working, and the user is sent to that job rather than a new one.
  redirect(
    outcomeUrl(
      base,
      { kind: "done", action: submitted.data.created ? "Analyse baseline" : "Resume baseline" },
      { job: submitted.data.jobId },
    ),
  );
}
