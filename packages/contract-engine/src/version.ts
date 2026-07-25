/**
 * The evaluator version.
 *
 * PRD section 11.12 makes byte-equivalence conditional on this value, and PRD section 14.11 stores
 * it beside every evaluation. It must be bumped whenever a change could alter any decision or any
 * byte of the canonical evaluation, because two results produced by different evaluators are not
 * comparable and without the version recorded that is undetectable — a release would appear to have
 * regressed when only the evaluator changed.
 *
 * Minor for a new rule type or a new field; patch for a fix that cannot change an existing decision;
 * major for a change in what an existing rule decides.
 */
export const EVALUATOR_VERSION = "1.0.0";
