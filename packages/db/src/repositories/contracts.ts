import type { ContractRule, TrajectoryContract } from "@flightrules/contract-schema";
import type { Severity } from "@flightrules/domain";
import { FlightRulesError } from "@flightrules/domain";
import { canonicalObject } from "../canonical.js";
import { type Page, type PageRequest, toPage } from "../pagination.js";
import type { Db } from "../sql.js";

/**
 * Contracts and their rules (PRD sections 14.9 and 14.10, FR-018).
 *
 * The lifecycle is `draft -> approved -> active -> superseded`, plus PRD section 8.9's `invalid`.
 * Every transition below names the state it expects and the state it produces in one guarded
 * `update`, so two concurrent activations cannot both read `approved` and both write `active`. The
 * partial unique index `contracts_one_active_per_environment` is the second line of defence: even a
 * transition written incorrectly cannot leave two active contracts for one agent and environment.
 *
 * `canonical_json` holds the value `canonicalContract` produces. That function sorts its own input,
 * so a contract loaded from a row hashes identically to the same contract loaded from YAML — which
 * is why a `jsonb` round trip is safe here in a way it is not for a canonical graph.
 */

export const CONTRACT_STATUSES = ["draft", "approved", "active", "superseded", "invalid"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_SOURCES = ["authored", "mined"] as const;
export type ContractSource = (typeof CONTRACT_SOURCES)[number];

/** PRD FR-018's transitions, plus validation moving a document in and out of `invalid`. */
export const CONTRACT_TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = {
  draft: ["approved", "invalid"],
  invalid: ["draft"],
  approved: ["active", "invalid"],
  active: ["superseded"],
  superseded: [],
};

export function canTransition(from: ContractStatus, to: ContractStatus): boolean {
  return CONTRACT_TRANSITIONS[from].includes(to);
}

interface ContractRow {
  readonly id: string;
  readonly agent_id: string;
  readonly baseline_version_id: string | null;
  readonly name: string;
  readonly contract_key: string;
  readonly semantic_version: string;
  readonly schema_version: string;
  readonly environment: string;
  readonly status: ContractStatus;
  readonly source: ContractSource;
  readonly yaml_text: string;
  readonly canonical_json: unknown;
  readonly content_hash: string;
  readonly validation_errors_json: unknown;
  readonly job_id: string | null;
  readonly approved_at: Date | null;
  readonly activated_at: Date | null;
  readonly superseded_at: Date | null;
  readonly superseded_by_contract_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface StoredContract {
  readonly id: string;
  readonly agentId: string;
  readonly baselineVersionId: string | null;
  readonly name: string;
  readonly contractKey: string;
  readonly semanticVersion: string;
  readonly schemaVersion: string;
  readonly environment: string;
  readonly status: ContractStatus;
  readonly source: ContractSource;
  readonly yamlText: string;
  readonly canonical: unknown;
  readonly contentHash: string;
  readonly validationErrors: unknown;
  readonly jobId: string | null;
  readonly approvedAt: Date | null;
  readonly activatedAt: Date | null;
  readonly supersededAt: Date | null;
  readonly supersededByContractId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredContractRule {
  readonly id: string;
  readonly contractId: string;
  readonly ruleKey: string;
  readonly ruleType: string;
  readonly severity: Severity;
  readonly zeroTolerance: boolean;
  readonly rule: unknown;
  readonly evidenceBasis: unknown;
  readonly createdAt: Date;
}

const CONTRACT_COLUMNS = [
  "id",
  "agent_id",
  "baseline_version_id",
  "name",
  "contract_key",
  "semantic_version",
  "schema_version",
  "environment",
  "status",
  "source",
  "yaml_text",
  "canonical_json",
  "content_hash",
  "validation_errors_json",
  "job_id",
  "approved_at",
  "activated_at",
  "superseded_at",
  "superseded_by_contract_id",
  "created_at",
  "updated_at",
] as const;

const RULE_COLUMNS = [
  "id",
  "contract_id",
  "rule_key",
  "rule_type",
  "severity",
  "zero_tolerance",
  "rule_json",
  "evidence_basis_json",
  "created_at",
] as const;

function toStoredContract(row: ContractRow): StoredContract {
  return {
    id: row.id,
    agentId: row.agent_id,
    baselineVersionId: row.baseline_version_id,
    name: row.name,
    contractKey: row.contract_key,
    semanticVersion: row.semantic_version,
    schemaVersion: row.schema_version,
    environment: row.environment,
    status: row.status,
    source: row.source,
    yamlText: row.yaml_text,
    canonical: row.canonical_json,
    contentHash: row.content_hash,
    validationErrors: row.validation_errors_json,
    jobId: row.job_id,
    approvedAt: row.approved_at,
    activatedAt: row.activated_at,
    supersededAt: row.superseded_at,
    supersededByContractId: row.superseded_by_contract_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredRule(row: {
  id: string;
  contract_id: string;
  rule_key: string;
  rule_type: string;
  severity: Severity;
  zero_tolerance: boolean;
  rule_json: unknown;
  evidence_basis_json: unknown;
  created_at: Date;
}): StoredContractRule {
  return {
    id: row.id,
    contractId: row.contract_id,
    ruleKey: row.rule_key,
    ruleType: row.rule_type,
    severity: row.severity,
    zeroTolerance: row.zero_tolerance,
    rule: row.rule_json,
    evidenceBasis: row.evidence_basis_json,
    createdAt: row.created_at,
  };
}

export interface CreateContractInput {
  readonly agentId: string;
  readonly baselineVersionId: string | null;
  readonly jobId: string | null;
  readonly environment: string;
  readonly source: ContractSource;
  readonly contract: TrajectoryContract;
  readonly canonical: unknown;
  readonly contentHash: string;
  readonly yamlText: string;
  /** Keyed by rule id. Absent for a hand-authored contract. */
  readonly evidenceByRuleId?: ReadonlyMap<string, unknown> | undefined;
}

/**
 * Creates a `draft` contract and its rule projection.
 *
 * Call inside a transaction. A contract row without its rules would report a policy with no rules,
 * which reads as a contract that permits everything — the most dangerous possible partial write.
 */
export async function createContract(
  sql: Db,
  input: CreateContractInput,
): Promise<{ contract: StoredContract; rules: readonly StoredContractRule[] }> {
  const metadata = input.contract.metadata;
  const zeroTolerance = new Set(input.contract.spec.gate.zeroToleranceRuleIds);

  const rows = await sql<ContractRow[]>`
    insert into contracts (
      agent_id, baseline_version_id, name, contract_key, semantic_version, schema_version,
      environment, status, source, yaml_text, canonical_json, content_hash, job_id
    ) values (
      ${input.agentId}, ${input.baselineVersionId}, ${metadata.name}, ${metadata.id},
      ${metadata.version}, ${input.contract.apiVersion}, ${input.environment},
      'draft', ${input.source}, ${input.yamlText},
      ${sql.json(canonicalObject(input.canonical))}::jsonb, ${input.contentHash}, ${input.jobId}
    )
    returning ${sql(CONTRACT_COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new Error("contracts returned no row");

  const rules: StoredContractRule[] = [];
  for (const rule of input.contract.spec.rules) {
    rules.push(
      await insertRule(sql, row.id, rule, zeroTolerance.has(rule.id), input.evidenceByRuleId),
    );
  }
  return { contract: toStoredContract(row), rules };
}

async function insertRule(
  sql: Db,
  contractId: string,
  rule: ContractRule,
  zeroTolerance: boolean,
  evidenceByRuleId: ReadonlyMap<string, unknown> | undefined,
): Promise<StoredContractRule> {
  const evidence = evidenceByRuleId?.get(rule.id);
  const rows = await sql<
    {
      id: string;
      contract_id: string;
      rule_key: string;
      rule_type: string;
      severity: Severity;
      zero_tolerance: boolean;
      rule_json: unknown;
      evidence_basis_json: unknown;
      created_at: Date;
    }[]
  >`
    insert into contract_rules
      (contract_id, rule_key, rule_type, severity, zero_tolerance, rule_json, evidence_basis_json)
    values (
      ${contractId}, ${rule.id}, ${rule.type}, ${rule.severity}, ${zeroTolerance},
      ${sql.json(canonicalObject(rule))}::jsonb,
      ${evidence === undefined ? null : sql.json(canonicalObject(evidence))}
    )
    returning ${sql(RULE_COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new Error("contract_rules returned no row");
  return toStoredRule(row);
}

export async function findContract(sql: Db, id: string): Promise<StoredContract | null> {
  const rows = await sql<ContractRow[]>`
    select ${sql(CONTRACT_COLUMNS)} from contracts where id = ${id}`;
  const row = rows[0];
  return row ? toStoredContract(row) : null;
}

export async function findActiveContract(
  sql: Db,
  agentId: string,
  environment: string,
): Promise<StoredContract | null> {
  const rows = await sql<ContractRow[]>`
    select ${sql(CONTRACT_COLUMNS)} from contracts
    where agent_id = ${agentId} and environment = ${environment} and status = 'active'`;
  const row = rows[0];
  return row ? toStoredContract(row) : null;
}

export async function listContractRules(
  sql: Db,
  contractId: string,
): Promise<readonly StoredContractRule[]> {
  const rows = await sql<
    {
      id: string;
      contract_id: string;
      rule_key: string;
      rule_type: string;
      severity: Severity;
      zero_tolerance: boolean;
      rule_json: unknown;
      evidence_basis_json: unknown;
      created_at: Date;
    }[]
  >`
    select ${sql(RULE_COLUMNS)} from contract_rules
    where contract_id = ${contractId} order by rule_key asc`;
  return rows.map(toStoredRule);
}

export async function listContracts(
  sql: Db,
  agentId: string,
  request: PageRequest,
): Promise<Page<StoredContract>> {
  const rows = await sql<ContractRow[]>`
    select ${sql(CONTRACT_COLUMNS)} from contracts
    where agent_id = ${agentId}
      and ${request.after === null ? sql`true` : sql`id < ${request.after}`}
    order by id desc
    limit ${request.limit + 1}`;
  return toPage(rows.map(toStoredContract), request);
}

export interface ReplaceDraftInput {
  readonly contractId: string;
  readonly contract: TrajectoryContract;
  readonly canonical: unknown;
  readonly contentHash: string;
  readonly yamlText: string;
}

/**
 * Replaces the body of a contract that is still a draft.
 *
 * An approved, active or superseded contract is immutable: it is the policy some release decision
 * was made against, and editing it would rewrite the meaning of every evaluation that already
 * cites it. The guard is `status = 'draft'` in SQL, so the refusal cannot be raced.
 */
export async function replaceDraft(
  sql: Db,
  input: ReplaceDraftInput,
): Promise<{ contract: StoredContract; rules: readonly StoredContractRule[] } | null> {
  const metadata = input.contract.metadata;
  const rows = await sql<ContractRow[]>`
    update contracts set
      name = ${metadata.name},
      contract_key = ${metadata.id},
      semantic_version = ${metadata.version},
      yaml_text = ${input.yamlText},
      canonical_json = ${sql.json(canonicalObject(input.canonical))}::jsonb,
      content_hash = ${input.contentHash},
      validation_errors_json = '[]'::jsonb,
      status = 'draft'
    where id = ${input.contractId} and status = 'draft'
    returning ${sql(CONTRACT_COLUMNS)}`;
  const row = rows[0];
  if (!row) return null;

  await sql`delete from contract_rules where contract_id = ${row.id}`;
  const zeroTolerance = new Set(input.contract.spec.gate.zeroToleranceRuleIds);
  const rules: StoredContractRule[] = [];
  for (const rule of input.contract.spec.rules) {
    rules.push(await insertRule(sql, row.id, rule, zeroTolerance.has(rule.id), undefined));
  }
  return { contract: toStoredContract(row), rules };
}

/** Records a failed revalidation. PRD FR-018: an invalid contract cannot be approved. */
export async function markContractInvalid(
  sql: Db,
  contractId: string,
  errors: readonly unknown[],
): Promise<StoredContract | null> {
  if (errors.length === 0)
    throw new RangeError("an invalid contract must carry at least one error");
  const rows = await sql<ContractRow[]>`
    update contracts set status = 'invalid',
      validation_errors_json = ${sql.json(canonicalObject(errors))}::jsonb
    where id = ${contractId} and status in ('draft', 'approved')
    returning ${sql(CONTRACT_COLUMNS)}`;
  const row = rows[0];
  return row ? toStoredContract(row) : null;
}

/** Clears a previous validation failure. `invalid -> draft` is the only way back. */
export async function markContractValid(
  sql: Db,
  contractId: string,
): Promise<StoredContract | null> {
  const rows = await sql<ContractRow[]>`
    update contracts set status = 'draft', validation_errors_json = '[]'::jsonb
    where id = ${contractId} and status = 'invalid'
    returning ${sql(CONTRACT_COLUMNS)}`;
  const row = rows[0];
  return row ? toStoredContract(row) : null;
}

export async function approveContract(sql: Db, contractId: string): Promise<StoredContract | null> {
  const rows = await sql<ContractRow[]>`
    update contracts set status = 'approved', approved_at = now()
    where id = ${contractId} and status = 'draft'
    returning ${sql(CONTRACT_COLUMNS)}`;
  const row = rows[0];
  return row ? toStoredContract(row) : null;
}

export interface ActivationResult {
  readonly activated: StoredContract;
  readonly superseded: StoredContract | null;
}

/**
 * Activates an approved contract, superseding the prior active one (FR-018).
 *
 * Must run inside a transaction. Supersession is written first so the partial unique index is never
 * momentarily violated, and both updates are guarded on the state they expect, so a concurrent
 * activation of a second contract fails on the index rather than producing two active policies.
 *
 * Historical evaluations are untouched: they reference the contract row by id, and a superseded
 * contract is never deleted.
 */
export async function activateContract(
  sql: Db,
  contractId: string,
): Promise<ActivationResult | null> {
  const target = await findContract(sql, contractId);
  if (!target) return null;
  if (target.status !== "approved") {
    throw new FlightRulesError("CONTRACT_CONFLICT", {
      message: `A contract must be approved before it can be activated; this one is ${target.status}.`,
      details: { contractId, status: target.status },
    });
  }

  const supersededRows = await sql<ContractRow[]>`
    update contracts set
      status = 'superseded',
      superseded_at = now(),
      superseded_by_contract_id = ${contractId}
    where agent_id = ${target.agentId}
      and environment = ${target.environment}
      and status = 'active'
    returning ${sql(CONTRACT_COLUMNS)}`;

  const activatedRows = await sql<ContractRow[]>`
    update contracts set status = 'active', activated_at = now()
    where id = ${contractId} and status = 'approved'
    returning ${sql(CONTRACT_COLUMNS)}`;
  const activated = activatedRows[0];
  if (!activated) {
    throw new FlightRulesError("CONTRACT_CONFLICT", {
      message: "The contract changed state while it was being activated.",
      details: { contractId },
    });
  }

  const superseded = supersededRows[0];
  return {
    activated: toStoredContract(activated),
    superseded: superseded ? toStoredContract(superseded) : null,
  };
}
