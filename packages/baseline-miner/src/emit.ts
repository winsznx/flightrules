import {
  CONTRACT_LIMITS,
  contractContentHash,
  formatValidationErrors,
  parseContract,
} from "@flightrules/contract-schema";
import { Document, isMap, isSeq } from "yaml";
import { gateDocument, ruleDocument } from "./document.js";
import type { ContractProposal, ProposedRule } from "./propose.js";
import { sanitiseText } from "./safety.js";

/**
 * Draft YAML generation (PRD Phase 08 task 11).
 *
 * The document is serialised from the same validated contract the proposal carries, then **re-read
 * through the public parser** and compared by content hash. So the emitted text is proven to be a
 * document the Phase 07 validator accepts and that still means the same thing after a round trip,
 * rather than a document that merely looks right.
 *
 * Comments carry the evidence basis for every rule, because a reviewer reads the YAML, not a separate
 * report. They are ignored by the parser and therefore cannot affect the content hash, which is what
 * makes it safe to put derived text in them.
 */

/**
 * Serialiser options.
 *
 * `aliasDuplicateObjects: false` is the load-bearing one: two rules sharing a structurally identical
 * selector object would otherwise be emitted as an anchor and an alias, and `loadContractDocument`
 * rejects both outright (SL-047). `lineWidth: 0` disables folding, so a long value is never wrapped
 * into a form whose reconstruction depends on the folding rules.
 */
const STRINGIFY_OPTIONS = {
  aliasDuplicateObjects: false,
  indent: 2,
  lineWidth: 0,
  nullStr: "null",
  simpleKeys: true,
} as const;

export const EMIT_ERROR_CODES = [
  "EMITTED_DOCUMENT_INVALID",
  "EMITTED_DOCUMENT_DRIFTED",
  "EMITTED_DOCUMENT_TOO_LARGE",
] as const;

export type EmitErrorCode = (typeof EMIT_ERROR_CODES)[number];

export interface EmitError {
  readonly code: EmitErrorCode;
  readonly message: string;
}

export type EmitResult =
  | { readonly ok: true; readonly yaml: string; readonly contentHash: string }
  | { readonly ok: false; readonly error: EmitError };

function comment(lines: readonly string[]): string {
  // Each line sanitised, so nothing telemetry-derived can inject a newline and escape the comment.
  return lines.map((line) => ` ${sanitiseText(line, 400).value}`).join("\n");
}

function headerLines(proposal: ContractProposal): readonly string[] {
  const lines: string[] = [
    " FlightRules generated this contract from mined baseline evidence. It is a DRAFT.",
    " Nothing here is enforced until a human approves and activates the contract.",
    "",
    ` Baseline        ${proposal.baselineVersionId}`,
    ` Sample size     ${proposal.sampleSize} approved run(s)`,
    ` Route families  ${proposal.approvedFamilyFingerprints.length} approved`,
    ` Normaliser      ${proposal.normaliserVersion} (${proposal.normaliserConfigHash.slice(0, 16)})`,
    ` Content hash    ${proposal.contentHash}`,
    "",
    " Assumptions",
  ];
  for (const assumption of proposal.assumptions) lines.push(`   - ${assumption}`);

  if (proposal.disclosures.length > 0) {
    lines.push("", " Disclosures");
    for (const disclosure of proposal.disclosures) {
      const subject = disclosure.subject.length === 0 ? "" : ` [${disclosure.subject}]`;
      lines.push(`   - ${disclosure.code}${subject}: ${disclosure.detail}`);
    }
  }

  lines.push("", " Approved route fingerprints");
  for (const fingerprint of proposal.approvedFamilyFingerprints) {
    lines.push(`   - sha256:${fingerprint}`);
  }

  return lines;
}

function ruleComment(entry: ProposedRule): readonly string[] {
  const lines = [
    ` ${entry.rule.id}`,
    `   basis        ${entry.evidence.basis} (${entry.evidence.subject})`,
    `   observed     ${entry.evidence.observed}`,
    `   recommended  ${entry.evidence.recommended}`,
    `   support      ${entry.evidence.support.decimal} over ${entry.evidence.sampleSize} run(s)`,
  ];
  if (entry.evidence.outliers.length > 0) {
    lines.push(`   outliers     ${entry.evidence.outliers.join(", ")} (not permitted)`);
  }
  if (entry.evidence.requiresHumanConfirmation) {
    lines.push("   review       this bound is not simply the observation; confirm it");
  }
  if (entry.evidence.representativeTraceIds.length > 0) {
    lines.push(`   traces       ${entry.evidence.representativeTraceIds.join(", ")}`);
  }
  return lines;
}

/**
 * Serialises a proposal to YAML and proves the round trip.
 *
 * The rules are emitted in the order the proposal holds them, which is sorted by rule identifier, so
 * two proposals over equivalent datasets produce byte-identical text.
 */
export function emitContractYaml(proposal: ContractProposal): EmitResult {
  const document = {
    apiVersion: proposal.contract.apiVersion,
    kind: proposal.contract.kind,
    metadata: {
      id: proposal.contract.metadata.id,
      name: proposal.contract.metadata.name,
      version: proposal.contract.metadata.version,
      project: proposal.contract.metadata.project,
      agent: proposal.contract.metadata.agent,
      environment: proposal.contract.metadata.environment,
      createdAt: proposal.contract.metadata.createdAt,
      ...(proposal.contract.metadata.baselineRelease === undefined
        ? {}
        : { baselineRelease: proposal.contract.metadata.baselineRelease }),
    },
    spec: {
      selectors: {
        workflowName: proposal.contract.spec.selectors.workflowName,
        releaseAttribute: proposal.contract.spec.selectors.releaseAttribute,
        environmentAttribute: proposal.contract.spec.selectors.environmentAttribute,
        ...(proposal.contract.spec.selectors.rootSpan === undefined
          ? {}
          : { rootSpan: proposal.contract.spec.selectors.rootSpan }),
      },
      approvedRoutes: proposal.contract.spec.approvedRoutes.map(
        (fingerprint) => `sha256:${fingerprint}`,
      ),
      rules: proposal.rules.map((entry) => ruleDocument(entry.rule, { prefixFingerprints: true })),
      gate: gateDocument(proposal.contract.spec.gate),
    },
  };

  const doc = new Document(document, STRINGIFY_OPTIONS);
  doc.commentBefore = comment(headerLines(proposal));

  const rules = doc.getIn(["spec", "rules"]);
  if (isSeq(rules)) {
    for (const [index, item] of rules.items.entries()) {
      const entry = proposal.rules[index];
      if (!isMap(item) || entry === undefined) continue;
      item.commentBefore = comment(ruleComment(entry));
    }
  }

  const yaml = doc.toString(STRINGIFY_OPTIONS);

  const bytes = Buffer.byteLength(yaml, "utf8");
  if (bytes > CONTRACT_LIMITS.maxSourceBytes) {
    return {
      ok: false,
      error: {
        code: "EMITTED_DOCUMENT_TOO_LARGE",
        message: `The generated document is ${bytes} bytes; a contract may not exceed ${CONTRACT_LIMITS.maxSourceBytes}.`,
      },
    };
  }

  const reparsed = parseContract(yaml);
  if (!reparsed.ok) {
    return {
      ok: false,
      error: {
        code: "EMITTED_DOCUMENT_INVALID",
        message: formatValidationErrors(reparsed.errors),
      },
    };
  }

  const expected = contractContentHash(proposal.contract);
  if (reparsed.value.contentHash !== expected) {
    return {
      ok: false,
      error: {
        code: "EMITTED_DOCUMENT_DRIFTED",
        message: `The re-read document hashes to ${reparsed.value.contentHash} but the proposal hashes to ${expected}, so serialisation changed the contract's meaning.`,
      },
    };
  }

  return { ok: true, yaml, contentHash: reparsed.value.contentHash };
}
