import { isFailure } from "@/lib/api";
import { downloadNameSegment } from "@/lib/download-name";
import { findGate, findRelease, findReleaseDiff } from "@/lib/load";

/**
 * `Download evidence` (PRD section 8.11, PRD Phase 14 task 8).
 *
 * The bundle is assembled here from two reads the product already serves — the gate decision and
 * the typed diff — so it can carry nothing they do not. That is the safety argument: there is no
 * code path by which a prompt, a tool argument, a tool result, a header or a customer field could
 * enter this document, because neither source contains one.
 *
 * What it does carry is exactly PRD Phase 14's list: release identity, baseline identity, the
 * decision and its hash, the active contract and its content hash, aggregate counts, the typed
 * changes, representative trace identifiers, violated and zero-tolerance rule identifiers, route
 * fingerprints, and the evidence hashes.
 *
 * Deterministic by construction: every field comes from a persisted decision, the key order is this
 * file's literal order, and the only clock read is the download timestamp, which is excluded from
 * the hash-bearing part of the document.
 */

export async function GET(
  _request: Request,
  context: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { releaseId } = await context.params;

  const [release, gate, diff] = await Promise.all([
    findRelease(releaseId),
    findGate(releaseId),
    findReleaseDiff(releaseId),
  ]);

  if (isFailure(release)) {
    return Response.json(
      { error: { code: release.code, message: release.message } },
      { status: release.status ?? 502 },
    );
  }
  if (isFailure(gate)) {
    return Response.json(
      { error: { code: gate.code, message: gate.message } },
      { status: gate.status ?? 502 },
    );
  }

  const decision = gate.data;
  const topology = isFailure(diff) ? null : diff.data;

  const bundle = {
    schemaVersion: "flightrules.evidence/v1",
    release: {
      id: decision.releaseId,
      key: decision.releaseKey,
      environment: decision.environment,
      commitSha: release.data.commitSha,
      imageDigest: release.data.imageDigest,
      firstObservedAt: release.data.firstObservedAt,
    },
    baseline: {
      releaseKey: decision.baselineReleaseKey,
      routeFamilyId: topology?.baseline?.routeFamilyId ?? null,
      fingerprint: topology?.baseline?.fingerprint ?? null,
      approvedRouteCount: topology?.approvedRouteCount ?? null,
    },
    decision: {
      outcome: decision.decision,
      exitCode: decision.exitCode,
      decisionHash: decision.decisionHash,
      evaluationId: decision.evaluationId,
      evaluationStatus: decision.evaluationStatus,
      evaluatorVersion: decision.evaluatorVersion,
    },
    contract: {
      id: decision.contractId,
      key: decision.contractKey,
      version: decision.contractVersion,
      contentHash: decision.contractContentHash,
      state: decision.contractState,
    },
    gate: decision.gate,
    counts: decision.counts,
    rates: decision.rates,
    changes: decision.changes,
    typedChanges: (topology?.changes ?? []).map((change) => ({
      kind: change.kind,
      label: change.label,
      severity: change.severity,
      subject: change.subject,
      baselineCount: change.baselineCount,
      candidateCount: change.candidateCount,
    })),
    findings: decision.findings,
    disclosures: [
      ...decision.disclosures.map((entry) => ({ code: entry.code, summary: entry.summary })),
      ...(topology?.disclosures ?? []),
    ],
    evidence: {
      representativeFailingTraceIds: decision.evidence.representativeFailingTraceIds,
      representativePassingTraceIds: decision.evidence.representativePassingTraceIds,
      violatedRuleIds: decision.evidence.violatedRuleIds,
      zeroToleranceRuleIds: decision.evidence.zeroToleranceRuleIds,
      observedRouteFingerprints: decision.evidence.observedRouteFingerprints,
    },
    generatedAt: new Date().toISOString(),
  };

  return new Response(`${JSON.stringify(bundle, null, 2)}\n`, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="release-evidence-${downloadNameSegment(decision.releaseKey)}-${decision.decisionHash.slice(0, 12)}.json"`,
      "cache-control": "no-store",
    },
  });
}
