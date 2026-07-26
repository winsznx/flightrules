"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiPost, isFailure } from "@/lib/api";
import { failureUrl, outcomeUrl } from "@/lib/outcome";

/**
 * The four route-family review actions of PRD section 8.8, and the contract proposal that follows
 * them (PRD Phase 13 task 6).
 *
 * Shared by the baseline capture page's family list and by the route-family detail page, so the
 * same click means the same thing from either place and writes the same audit event.
 *
 * Every one of them is a real API call whose result is re-read on the next render. None of them
 * updates a local copy of the family's status: PRD Phase 13 requires the server-confirmed state,
 * and a family that looked approved in the browser but was not is exactly the failure the product
 * exists to prevent elsewhere.
 *
 * Duplicate submission is safe by construction. Approving an already-approved family writes the
 * same status and the API answers the same body; the baseline's own status transition is the only
 * side effect and it is already idempotent.
 */

const DecisionResponse = z.object({
  family: z.object({ id: z.string(), status: z.string(), fingerprint: z.string() }),
  baselineStatus: z.string(),
});

const JobAccepted = z.object({ jobId: z.string(), status: z.string(), created: z.boolean() });

/** PRD section 8.8's four verbs, and the API call each one is. */
const DECISIONS = {
  approve: { path: "approve", body: {}, label: "Approve" },
  markOptional: { path: "approve", body: { markOptional: true }, label: "Mark optional" },
  reject: { path: "exclude", body: {}, label: "Reject" },
  excludeFixture: {
    path: "exclude",
    body: { asFixtureError: true },
    label: "Exclude as fixture error",
  },
} as const;

type DecisionKey = keyof typeof DECISIONS;

function decisionKeyOf(value: unknown): DecisionKey | null {
  return typeof value === "string" && value in DECISIONS ? (value as DecisionKey) : null;
}

export async function decideRouteFamily(formData: FormData): Promise<void> {
  const returnTo = String(formData.get("returnTo") ?? "/projects");
  const baselineId = String(formData.get("baselineId") ?? "");
  const familyId = String(formData.get("familyId") ?? "");
  const decision = decisionKeyOf(formData.get("decision"));

  if (decision === null) {
    redirect(
      outcomeUrl(returnTo, {
        kind: "failed",
        action: "Review route family",
        code: "VALIDATION_FAILED",
        detail: "That review decision is not one this product offers.",
      }),
    );
  }

  const chosen = DECISIONS[decision];
  const result = await apiPost(
    `/api/baselines/${baselineId}/route-families/${familyId}/${chosen.path}`,
    chosen.body,
    DecisionResponse,
  );

  if (isFailure(result)) {
    redirect(failureUrl(returnTo, chosen.label, result));
  }

  revalidatePath(returnTo);
  redirect(outcomeUrl(returnTo, { kind: "done", action: chosen.label }));
}

export async function proposeContract(formData: FormData): Promise<void> {
  const returnTo = String(formData.get("returnTo") ?? "/projects");
  const baselineId = String(formData.get("baselineId") ?? "");
  const workflowName = String(formData.get("workflowName") ?? "").trim();
  const environment = String(formData.get("environment") ?? "").trim();

  if (workflowName.length === 0) {
    redirect(
      outcomeUrl(returnTo, {
        kind: "failed",
        action: "Propose contract",
        code: "VALIDATION_FAILED",
        detail: "A proposal needs the workflow name the contract will select on.",
      }),
    );
  }

  const submitted = await apiPost(
    `/api/baselines/${baselineId}/propose-contract`,
    {
      workflowName,
      ...(environment.length === 0 ? {} : { environment }),
    },
    JobAccepted,
  );

  if (isFailure(submitted)) {
    redirect(failureUrl(returnTo, "Propose contract", submitted));
  }

  revalidatePath(returnTo);
  redirect(
    outcomeUrl(
      returnTo,
      { kind: "done", action: submitted.data.created ? "Propose contract" : "Resume proposal" },
      { job: submitted.data.jobId },
    ),
  );
}
