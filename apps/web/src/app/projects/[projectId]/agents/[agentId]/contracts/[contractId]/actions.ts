"use server";

import { applyRuleControl, RULE_CONTROLS, type RuleControl } from "@flightrules/contract-schema";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiGet, apiPost, apiPut, isFailure } from "@/lib/api";
import { failureUrl, outcomeUrl } from "@/lib/outcome";

/**
 * The Contract Studio's lifecycle and editing actions (PRD Phase 13 tasks 8 to 11).
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. **Activation is guarded on the server.** A disabled button is a hint, not a control. Every
 *    guard PRD Phase 13 lists — invalid YAML, failed validation, unsaved changes, saved-but-
 *    unvalidated changes, an illegal lifecycle state — is checked here, before the API is called,
 *    and the API's own `canTransition` refuses independently. Two locks, because the studio is not
 *    the only caller.
 *
 * 2. **A graph rule control is a document transformation, not a rule builder.** It runs through
 *    `applyRuleControl` in `@flightrules/contract-schema`, which re-validates through the Phase 07
 *    parser before returning, and the result is saved by the same `PUT` a hand edit uses. So the
 *    two editing surfaces cannot produce different documents, because they are the same write.
 */

const ContractSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  status: z.string(),
  contentHash: z.string(),
  validationErrors: z.unknown(),
});

const ExportSchema = z.object({
  contractId: z.string(),
  contentHash: z.string(),
  yaml: z.string(),
});

const ValidationSchema = z.object({
  valid: z.boolean(),
  status: z.string(),
  contentHash: z.string(),
  contentHashStable: z.boolean(),
  errors: z.array(z.unknown()),
});

const JobAccepted = z.object({
  jobId: z.string(),
  status: z.string(),
  created: z.boolean(),
});

function pathOf(projectId: string, agentId: string, contractId: string): string {
  return `/projects/${projectId}/agents/${agentId}/contracts/${contractId}`;
}

/** The three identifiers every action on this page carries, read once. */
function routeOf(formData: FormData): {
  projectId: string;
  agentId: string;
  contractId: string;
  here: string;
} {
  const projectId = String(formData.get("projectId") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const contractId = String(formData.get("contractId") ?? "");
  return { projectId, agentId, contractId, here: pathOf(projectId, agentId, contractId) };
}

/* -------------------------------------------------------------------------- */
/* Editing                                                                    */
/* -------------------------------------------------------------------------- */

export interface StudioRoute {
  readonly projectId: string;
  readonly agentId: string;
  readonly contractId: string;
}

/**
 * The YAML editor's save.
 *
 * Bound to its route rather than reading hidden fields, because the form lives inside the client
 * editor component and a bound argument cannot be edited by the browser the way a hidden input can.
 */
export async function saveContract(route: StudioRoute, formData: FormData): Promise<void> {
  const { contractId } = route;
  const here = pathOf(route.projectId, route.agentId, contractId);
  const yaml = String(formData.get("yaml") ?? "");

  if (yaml.trim().length === 0) {
    redirect(
      outcomeUrl(here, {
        kind: "failed",
        action: "Save document",
        code: "CONTRACT_INVALID",
        detail: "An empty document is not a contract.",
      }),
    );
  }

  // `PUT` parses and validates server-side and refuses a non-draft contract, so an invalid document
  // is never stored and an immutable version is never overwritten.
  const saved = await apiPut(`/api/contracts/${contractId}`, { yaml }, ContractSchema);
  if (isFailure(saved)) {
    redirect(failureUrl(here, "Save document", saved));
  }

  revalidatePath(here);
  // Saved is not validated. PRD Phase 13 forbids approving a saved-but-unvalidated change, and the
  // studio says so until `Validate contract` has run against the stored text.
  redirect(outcomeUrl(here, { kind: "done", action: "Save document" }, { saved: "1" }));
}

export async function applyControl(formData: FormData): Promise<void> {
  const { contractId, here } = routeOf(formData);

  const control = String(formData.get("control") ?? "");
  if (!(RULE_CONTROLS as readonly string[]).includes(control)) {
    redirect(
      outcomeUrl(here, {
        kind: "failed",
        action: "Apply rule control",
        code: "VALIDATION_FAILED",
        detail: "That is not one of the eight controls this product offers.",
      }),
    );
  }

  const node = String(formData.get("node") ?? "").trim();
  if (node.length === 0) {
    redirect(
      outcomeUrl(here, {
        kind: "failed",
        action: "Apply rule control",
        code: "VALIDATION_FAILED",
        detail: "A rule control needs the step it constrains.",
      }),
    );
  }

  const other = String(formData.get("other") ?? "").trim();
  const value = String(formData.get("value") ?? "").trim();
  const rawLimit = String(formData.get("limit") ?? "").trim();
  const limit = rawLimit.length === 0 ? undefined : Number(rawLimit);

  const current = await apiGet(`/api/contracts/${contractId}/export`, ExportSchema);
  if (isFailure(current)) {
    redirect(failureUrl(here, "Apply rule control", current));
  }

  const edited = applyRuleControl(current.data.yaml, {
    control: control as RuleControl,
    node,
    ...(other.length === 0 ? {} : { other }),
    ...(value.length === 0 ? {} : { value }),
    ...(limit === undefined ? {} : { limit }),
  });

  if (!edited.ok) {
    redirect(
      outcomeUrl(here, {
        kind: "failed",
        action: "Apply rule control",
        code: edited.error.code,
        detail: edited.error.message,
      }),
    );
  }

  if (edited.effect === "unchanged") {
    redirect(outcomeUrl(here, { kind: "done", action: "Apply rule control" }));
  }

  const saved = await apiPut(`/api/contracts/${contractId}`, { yaml: edited.yaml }, ContractSchema);
  if (isFailure(saved)) {
    redirect(failureUrl(here, "Apply rule control", saved));
  }

  revalidatePath(here);
  redirect(outcomeUrl(here, { kind: "done", action: "Apply rule control" }, { saved: "1" }));
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

export async function validateContract(formData: FormData): Promise<void> {
  const { contractId, here } = routeOf(formData);

  const result = await apiPost(`/api/contracts/${contractId}/validate`, {}, ValidationSchema);
  if (isFailure(result)) {
    redirect(failureUrl(here, "Validate contract", result));
  }

  revalidatePath(here);
  if (!result.data.valid) {
    redirect(
      outcomeUrl(here, {
        kind: "failed",
        action: "Validate contract",
        code: "CONTRACT_INVALID",
        detail: `The stored document has ${String(result.data.errors.length)} validation error(s). The contract is now invalid.`,
      }),
    );
  }

  // `validated=1` is what distinguishes "saved" from "saved and validated". PRD Phase 13 forbids
  // approving the former.
  redirect(outcomeUrl(here, { kind: "done", action: "Validate contract" }, { validated: "1" }));
}

export async function approveContract(formData: FormData): Promise<void> {
  const { contractId, here } = routeOf(formData);

  // The unvalidated-changes guard is a fact about the stored document, established here by
  // revalidating it — never a query parameter the caller could have written. `contentHashStable`
  // is the part that catches a saved-but-unvalidated change: the stored hash no longer describes
  // the stored text until a validation has run over it.
  const revalidated = await apiPost(`/api/contracts/${contractId}/validate`, {}, ValidationSchema);
  if (isFailure(revalidated)) {
    redirect(failureUrl(here, "Approve version", revalidated));
  }
  if (!revalidated.data.valid || !revalidated.data.contentHashStable) {
    redirect(
      outcomeUrl(here, {
        kind: "failed",
        action: "Approve version",
        code: "CONTRACT_INVALID",
        detail: "This contract has unvalidated changes. Validate it before approval.",
      }),
    );
  }

  const result = await apiPost(`/api/contracts/${contractId}/approve`, {}, ContractSchema);
  if (isFailure(result)) {
    redirect(failureUrl(here, "Approve version", result));
  }

  revalidatePath(here);
  redirect(outcomeUrl(here, { kind: "done", action: "Approve version" }));
}

export async function activateContract(formData: FormData): Promise<void> {
  const { contractId, here } = routeOf(formData);

  // Re-read rather than trusting the state the page was rendered from. A contract may have moved
  // between the render and the click, and activation is the transition that starts enforcing rules.
  const contract = await apiGet(`/api/contracts/${contractId}`, ContractSchema);
  if (isFailure(contract)) {
    redirect(failureUrl(here, "Activate version", contract));
  }
  if (contract.data.status !== "approved") {
    redirect(
      outcomeUrl(here, {
        kind: "failed",
        action: "Activate version",
        code: "STATE_TRANSITION_INVALID",
        detail: `Only an approved contract can be activated. This one is ${contract.data.status}.`,
      }),
    );
  }

  const result = await apiPost(`/api/contracts/${contractId}/activate`, {}, ContractSchema);
  if (isFailure(result)) {
    redirect(failureUrl(here, "Activate version", result));
  }

  revalidatePath(here);
  redirect(outcomeUrl(here, { kind: "done", action: "Activate version" }));
}

export async function syncSignoz(formData: FormData): Promise<void> {
  const { contractId, here } = routeOf(formData);

  const result = await apiPost(`/api/contracts/${contractId}/sync-signoz`, {}, JobAccepted);
  if (isFailure(result)) {
    redirect(failureUrl(here, "Sync to SigNoz", result));
  }

  revalidatePath(here);
  // The job identifier goes in the address, so the sync's progress and its read-back verification
  // are visible on reload rather than only in the moment.
  redirect(
    outcomeUrl(
      here,
      { kind: "done", action: result.data.created ? "Sync to SigNoz" : "Resume sync" },
      { job: result.data.jobId },
    ),
  );
}
