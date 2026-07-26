import { createHash } from "node:crypto";
import { type Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import { ErrorBag, type ValidationError } from "./errors.js";
import { parseContract } from "./parse.js";
import { CONTRACT_LIMITS } from "./types.js";
import { loadContractDocument, YAML_PARSE_OPTIONS } from "./yaml.js";

/**
 * Deterministic contract editing (PRD Phase 13 tasks 9 and 11, PRD section 8.9).
 *
 * The Contract Studio offers eight graph node rule controls and a YAML editor. They are two views
 * of **one** document: a control edit is a named transformation of the stored YAML, applied here,
 * and never a second model held beside it. Nothing can drift because there is nothing to drift
 * from.
 *
 * Every transformation ends the same way: serialise, re-read through `parseContract`, and refuse
 * the edit if the result does not validate. So a control cannot produce a document the Phase 07
 * validator rejects, and the studio cannot show an approvable state the API would refuse.
 *
 * This module decides no contract semantics of its own. It builds the document shapes PRD section
 * 10.4 defines and hands them to the existing validator, which remains the only authority on what a
 * contract means.
 */

/** PRD section 8.9's eight controls, in the PRD's own order. */
export const RULE_CONTROLS = [
  "required",
  "optional",
  "forbidden",
  "maximum_calls",
  "must_precede",
  "must_descend_from",
  "side_effect",
  "sensitive_data_domain",
] as const;

export type RuleControl = (typeof RULE_CONTROLS)[number];

/** The two node classifications FlightRules normalises, PRD section 17.2. */
export const SIDE_EFFECT_FIELD = "agent.side_effect";
export const DATA_DOMAIN_FIELD = "agent.data_domain";

export interface RuleControlRequest {
  readonly control: RuleControl;
  /** Canonical span name the control constrains. Never a span ID. */
  readonly node: string;
  /** The second node, for the two relational controls. */
  readonly other?: string | undefined;
  /** The bound, for `maximum_calls`. */
  readonly limit?: number | undefined;
  /** The required value, for the two classification controls. */
  readonly value?: string | undefined;
  /** Severity of a rule this control creates. Defaults to `high`. */
  readonly severity?: "low" | "medium" | "high" | "critical" | undefined;
}

export const EDIT_ERROR_CODES = [
  "DOCUMENT_UNREADABLE",
  "DOCUMENT_SHAPE_UNEXPECTED",
  "CONTROL_ARGUMENT_MISSING",
  "CONTROL_ARGUMENT_INVALID",
  "RULE_LIMIT_REACHED",
  "EDITED_DOCUMENT_INVALID",
] as const;

export type EditErrorCode = (typeof EDIT_ERROR_CODES)[number];

export interface EditError {
  readonly code: EditErrorCode;
  readonly message: string;
  /** Present when the failure is the validator's, so the studio can show the same list it shows for a hand edit. */
  readonly errors?: readonly ValidationError[];
}

export type EditResult =
  | {
      readonly ok: true;
      readonly yaml: string;
      readonly contentHash: string;
      /** Identifier of the rule the edit added or removed, for the audit detail and the test. */
      readonly ruleId: string;
      readonly effect: "added" | "removed" | "replaced" | "unchanged";
    }
  | { readonly ok: false; readonly error: EditError };

/**
 * Serialiser options.
 *
 * Identical to the emitter's in `@flightrules/baseline-miner`, and for the same reason:
 * `aliasDuplicateObjects: false` stops two structurally identical selectors from being written as
 * an anchor and an alias, which `loadContractDocument` rejects outright (SL-047), and
 * `lineWidth: 0` disables folding so a long value never depends on the folding rules to be read
 * back.
 */
const STRINGIFY_OPTIONS = {
  aliasDuplicateObjects: false,
  indent: 2,
  lineWidth: 0,
  nullStr: "null",
  simpleKeys: true,
} as const;

/**
 * A stable identifier for the rule a control produces.
 *
 * Derived from the control and its arguments, so applying the same control twice targets the same
 * rule and the second application is a replacement rather than a duplicate. That is what makes a
 * double-clicked control idempotent rather than additive.
 */
export function controlRuleId(request: RuleControlRequest): string {
  const label = [request.control, request.node, request.other ?? "", request.value ?? ""].join("|");
  const digest = createHash("sha256").update(label).digest("hex").slice(0, 8);

  const folded = [...`${request.control}-${request.node}`.toLowerCase()]
    .map((character) => (/[a-z0-9]/.test(character) ? character : "-"))
    .join("")
    .slice(0, 80)
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return folded.length === 0 ? `control-${digest}` : `${folded}-${digest}`;
}

function fail(
  code: EditErrorCode,
  message: string,
  errors?: readonly ValidationError[],
): EditResult {
  return { ok: false, error: errors === undefined ? { code, message } : { code, message, errors } };
}

type RuleDocumentResult =
  | { readonly ok: true; readonly document: Record<string, unknown> }
  | { readonly ok: false; readonly error: EditError };

const built = (document: Record<string, unknown>): RuleDocumentResult => ({ ok: true, document });
const refused = (code: EditErrorCode, message: string): RuleDocumentResult => ({
  ok: false,
  error: { code, message },
});

/** The rule document a control produces, or a reason it cannot. */
function ruleDocumentFor(request: RuleControlRequest, id: string): RuleDocumentResult {
  const severity = request.severity ?? "high";
  const selector = { name: request.node };

  switch (request.control) {
    case "required":
      return built({
        id,
        type: "required_span",
        severity,
        description: `${request.node} must appear in every run.`,
        selector,
        cardinality: { min: 1, max: request.limit ?? 1 },
      });

    case "optional":
      // A node is optional exactly when nothing requires it. The control removes rather than adds,
      // and `applyRuleControl` handles that before reaching here.
      return refused(
        "CONTROL_ARGUMENT_INVALID",
        "`optional` removes a requirement and produces no rule.",
      );

    case "forbidden":
      return built({
        id,
        type: "forbidden_span",
        severity,
        description: `${request.node} must not appear.`,
        selector,
      });

    case "maximum_calls": {
      const limit = request.limit;
      if (limit === undefined) {
        return refused("CONTROL_ARGUMENT_MISSING", "`maximum_calls` needs a limit.");
      }
      if (!Number.isInteger(limit) || limit < 0 || limit > CONTRACT_LIMITS.maxInteger) {
        return refused(
          "CONTROL_ARGUMENT_INVALID",
          "A maximum call count must be a non-negative integer.",
        );
      }
      return built({
        id,
        type: "cardinality",
        severity,
        description: `${request.node} may occur at most ${String(limit)} time(s) per run.`,
        selector,
        min: 0,
        max: limit,
        scope: "run",
      });
    }

    case "must_precede": {
      const other = request.other;
      if (other === undefined || other.length === 0) {
        return refused(
          "CONTROL_ARGUMENT_MISSING",
          "`must_precede` needs the node that must follow.",
        );
      }
      return built({
        id,
        type: "required_edge",
        severity,
        description: `${request.node} must be answered by ${other}.`,
        from: selector,
        to: { name: other },
        relationship: "any_depth",
      });
    }

    case "must_descend_from": {
      const other = request.other;
      if (other === undefined || other.length === 0) {
        return refused("CONTROL_ARGUMENT_MISSING", "`must_descend_from` needs the ancestor node.");
      }
      return built({
        id,
        type: "required_ancestry",
        severity,
        description: `${request.node} must descend from ${other}.`,
        ancestor: { name: other },
        descendant: selector,
        relationship: "any_depth",
      });
    }

    case "side_effect":
    case "sensitive_data_domain": {
      const value = request.value;
      if (value === undefined || value.length === 0) {
        return refused(
          "CONTROL_ARGUMENT_MISSING",
          "A classification control needs the value it requires.",
        );
      }
      const field = request.control === "side_effect" ? SIDE_EFFECT_FIELD : DATA_DOMAIN_FIELD;
      return built({
        id,
        type: "attribute_constraint",
        severity,
        description: `${request.node} must declare ${field} = ${value}.`,
        selector,
        field,
        operator: "equals",
        value,
      });
    }
  }
}

/** The `spec.rules` sequence of a document, or `null` when the document is not one FlightRules wrote. */
function rulesSequenceOf(document: Document): YAMLSeq | null {
  const spec: unknown = document.get("spec");
  if (!isMap(spec)) return null;
  const rules: unknown = (spec as YAMLMap).get("rules");
  return isSeq(rules) ? (rules as YAMLSeq) : null;
}

function ruleIdAt(rules: YAMLSeq, index: number): string | null {
  const item: unknown = rules.get(index);
  if (!isMap(item)) return null;
  const id: unknown = (item as YAMLMap).get("id");
  return typeof id === "string" ? id : null;
}

/**
 * Applies one graph rule control to a stored contract document.
 *
 * The edit is structural, not textual: the document is parsed to its AST, one sequence entry is
 * added, replaced or removed, and the result is re-serialised. Comments elsewhere in the document —
 * including every evidence-basis comment the miner wrote — survive, because nothing outside the
 * edited entry is touched.
 */
export function applyRuleControl(source: string, request: RuleControlRequest): EditResult {
  // The same safe load the parser performs, so an aliased, tagged, oversized or over-nested
  // document is refused here exactly as it would be on the way in.
  const loaded = loadContractDocument(source, new ErrorBag());
  if (!loaded.ok) {
    return fail(
      "DOCUMENT_UNREADABLE",
      "The stored contract document could not be read.",
      loaded.errors,
    );
  }

  // Re-read as an AST rather than rebuilding from the resolved value. `loadContractDocument`
  // returns plain JavaScript, which has no comments in it — and a mined contract carries its whole
  // evidence basis in comments, which the reviewer reads. The safety checks above have already run
  // over this exact source, so this parse adds no new trust, only the comments.
  const document = parseDocument(source, YAML_PARSE_OPTIONS);
  const sequence = rulesSequenceOf(document);
  if (sequence === null) {
    return fail("DOCUMENT_SHAPE_UNEXPECTED", "The document has no `spec.rules` sequence to edit.");
  }

  const id = controlRuleId(request);
  const existingIndex = sequence.items.findIndex((_, index) => ruleIdAt(sequence, index) === id);

  let effect: "added" | "removed" | "replaced" | "unchanged";

  if (request.control === "optional") {
    // `optional` is the removal of the requirement `required` created for the same node. Its target
    // is that rule's identifier, not its own, so the two controls are exact inverses.
    const requiredId = controlRuleId({ ...request, control: "required" });
    const target = sequence.items.findIndex((_, index) => ruleIdAt(sequence, index) === requiredId);
    if (target < 0) {
      // Nothing required it, so it is already optional. The document is returned unchanged rather
      // than rewritten, which keeps a repeated click from churning the content hash.
      const unchanged = parseContract(source);
      return unchanged.ok
        ? {
            ok: true,
            yaml: source,
            contentHash: unchanged.value.contentHash,
            ruleId: requiredId,
            effect: "unchanged",
          }
        : fail(
            "DOCUMENT_UNREADABLE",
            "The stored contract document does not validate.",
            unchanged.errors,
          );
    }
    sequence.items.splice(target, 1);
    effect = "removed";
  } else {
    const candidate = ruleDocumentFor(request, id);
    if (!candidate.ok) return { ok: false, error: candidate.error };

    if (existingIndex >= 0) {
      sequence.items[existingIndex] = document.createNode(candidate.document);
      effect = "replaced";
    } else {
      if (sequence.items.length >= CONTRACT_LIMITS.maxRules) {
        return fail(
          "RULE_LIMIT_REACHED",
          `A contract may hold at most ${String(CONTRACT_LIMITS.maxRules)} rules.`,
        );
      }
      sequence.add(document.createNode(candidate.document));
      effect = "added";
    }
  }

  const yaml = document.toString(STRINGIFY_OPTIONS);

  // The transformation is only complete when the document it produced is one the product would
  // have accepted from a human. A control that could write an invalid contract would be a way to
  // reach an unapprovable state through a button.
  const parsed = parseContract(yaml);
  if (!parsed.ok) {
    return fail(
      "EDITED_DOCUMENT_INVALID",
      "That control produced a document the contract validator rejects. Nothing was changed.",
      parsed.errors,
    );
  }

  return { ok: true, yaml, contentHash: parsed.value.contentHash, ruleId: id, effect };
}

/**
 * Which controls a node currently carries, read from the stored document.
 *
 * The studio renders control state from this rather than from its own memory, so a YAML edit that
 * removes a rule is reflected in the graph controls on the next render without a second update
 * path. This is the "YAML edit changes graph rule state predictably" direction of PRD Phase 13's
 * bidirectional requirement; `applyRuleControl` is the other.
 */
export function controlStateOf(
  source: string,
  node: string,
): { readonly control: RuleControl; readonly ruleId: string; readonly detail: string }[] {
  const parsed = parseContract(source);
  if (!parsed.ok) return [];

  const state: { control: RuleControl; ruleId: string; detail: string }[] = [];
  for (const rule of parsed.value.contract.spec.rules) {
    switch (rule.type) {
      case "required_span":
        if (rule.selector.name === node) {
          state.push({
            control: "required",
            ruleId: rule.id,
            detail: `at least ${String(rule.cardinality.min)}, at most ${String(rule.cardinality.max)}`,
          });
        }
        break;
      case "forbidden_span":
        if (rule.selector.name === node) {
          state.push({ control: "forbidden", ruleId: rule.id, detail: "must not appear" });
        }
        break;
      case "cardinality":
        if (rule.selector.name === node) {
          state.push({
            control: "maximum_calls",
            ruleId: rule.id,
            detail: `at most ${String(rule.max)} per ${rule.scope}`,
          });
        }
        break;
      case "required_edge":
        if (rule.from.name === node) {
          state.push({
            control: "must_precede",
            ruleId: rule.id,
            detail: `answered by ${rule.to.name ?? rule.to.namePattern ?? "—"}`,
          });
        }
        break;
      case "required_ancestry":
        if (rule.descendant.name === node) {
          state.push({
            control: "must_descend_from",
            ruleId: rule.id,
            detail: `descends from ${rule.ancestor.name ?? rule.ancestor.namePattern ?? "—"}`,
          });
        }
        break;
      case "attribute_constraint":
        if (rule.selector.name === node && rule.field === SIDE_EFFECT_FIELD) {
          state.push({
            control: "side_effect",
            ruleId: rule.id,
            detail: `${rule.operator} ${String(rule.value ?? "")}`,
          });
        } else if (rule.selector.name === node && rule.field === DATA_DOMAIN_FIELD) {
          state.push({
            control: "sensitive_data_domain",
            ruleId: rule.id,
            detail: `${rule.operator} ${String(rule.value ?? "")}`,
          });
        }
        break;
      default:
        break;
    }
  }

  // Sorted by the PRD's control order, then by identifier, so the same document always renders the
  // same list.
  return state.sort((a, b) =>
    a.control !== b.control
      ? RULE_CONTROLS.indexOf(a.control) - RULE_CONTROLS.indexOf(b.control)
      : a.ruleId < b.ruleId
        ? -1
        : 1,
  );
}
