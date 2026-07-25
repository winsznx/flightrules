# FlightRules

## End-to-End Product Requirements Document and Claude Code Build Protocol

Document version: 1.0  
Product status: Build specification  
Hackathon track: AI & Agent Observability  
Primary platform: SigNoz, OpenTelemetry, SigNoz MCP Server, SigNoz Foundry  
Working product name: FlightRules  
Tagline: Agents change their route without changing their answer. FlightRules catches the route.  
Source-baseline date: 25 July 2026

---

# 1. Purpose of this document

This file is the authoritative product, architecture, implementation, testing, validation, user experience, and delivery specification for FlightRules.

Claude Code must use this document to build the product phase by phase. Claude must not treat any product requirement, API shape, package version, SigNoz capability, OpenTelemetry convention, Foundry field, MCP tool, deployment command, or UI behaviour as true until it has been checked against the current official documentation or the installed runtime.

A separate `design.md` file will be provided later. That file will define visual colours, typography, spacing, logos, illustrations, and asset usage. It will not override this PRD's product logic, information architecture, route names, page purposes, content hierarchy, product wording, interaction requirements, states, tests, or acceptance criteria.

The product must remain coherent even before `design.md` arrives. Claude may build semantic HTML, layout primitives, accessibility structure, loading states, and test selectors before the visual phase. Claude must not invent a permanent colour system or brand aesthetic.

---

# 2. Claude Code operating contract

## 2.1 Non-negotiable execution rules

Claude must follow these rules for the entire build:

1. Work on one numbered phase at a time.
2. Do not start a phase until its entry criteria are satisfied.
3. Do not mark a phase complete until every required test and validation has run successfully.
4. Do not claim a feature works because code exists. Runtime evidence is required.
5. Do not infer undocumented request or response shapes.
6. Do not invent SigNoz API endpoints, MCP tools, OpenTelemetry attributes, Foundry fields, package options, environment variables, or CLI flags.
7. Use official primary sources first: official SigNoz documentation, official SigNoz GitHub repositories, official OpenTelemetry specifications and repositories, and official package documentation.
8. Record every external technical decision in `docs/research/source-lock.md` with the source URL, source commit or release when available, access date, verified claim, and implementation consequence.
9. When documentation and runtime behaviour disagree, treat the runtime as authoritative for the installed version. Record the mismatch.
10. When two official sources disagree, stop the affected implementation, record both sources, inspect the installed source or schema, and resolve the conflict with evidence.
11. Never silently downgrade a requirement.
12. Never replace a required integration with a mock and call the phase complete.
13. Mocks are permitted only in unit tests and deterministic offline fixtures.
14. No placeholder `return true`, fake telemetry, hard-coded dashboard screenshots, fabricated trace IDs, fake MCP responses, or manually inserted database rows may be used as proof.
15. No unresolved P0 TODO, FIXME, stub, disabled test, skipped test, or commented-out implementation may remain at submission.
16. Every write through SigNoz MCP must be followed by a list or get operation that confirms the created resource and validates the important fields.
17. Every generated dashboard panel must return real data from the seeded demo after the demo is run.
18. Every alert must be forced through at least one known firing state and one recovery state where the installed SigNoz version supports that validation.
19. Every trace rule must be tested against both a passing and violating trace.
20. Main must remain green. Do not merge a phase branch with failing checks.
21. Use focused commits. Do not add co-author trailers.
22. Do not rewrite unrelated code while completing a phase.
23. Do not expose secrets in source, logs, test snapshots, screenshots, browser storage, or telemetry.
24. Never capture chain-of-thought. FlightRules evaluates observable execution structure and safe metadata only.
25. Before changing an existing file, read the relevant surrounding code and tests.
26. After each phase, update the acceptance matrix, evidence log, architecture decision record, and changelog.

## 2.2 Required source hierarchy

Use this order when verifying technical claims:

1. Installed runtime schema, generated OpenAPI schema, MCP tool discovery output, or source code at the pinned commit.
2. Official versioned documentation for the installed version.
3. Official repository documentation at the pinned commit.
4. Official latest documentation, only when versioned documentation is unavailable.
5. Maintainer issue or pull request, clearly marked as unstable or proposed.

Blog posts, third-party tutorials, copied snippets, Stack Overflow answers, and model memory cannot be used as the only source for an implementation decision.

## 2.3 Mandatory phase workflow

For every phase, Claude must perform the following sequence:

1. Read this PRD section for the phase.
2. Read all files listed under the phase entry criteria.
3. Inspect the current repository status and active branch.
4. Create the phase branch.
5. Write a short execution note in `docs/evidence/phase-XX-plan.md`.
6. Verify the official documentation and runtime capabilities required by the phase.
7. Implement the smallest complete slice that satisfies the phase.
8. Add or update tests before claiming completion.
9. Run the phase test commands.
10. Run all earlier regression tests.
11. Validate the result through the actual running system where applicable.
12. Write `docs/evidence/phase-XX-result.md` with commands, outputs, screenshots where useful, resource IDs internally, trace IDs internally, failures found, and how they were resolved.
13. Update `docs/ACCEPTANCE_MATRIX.md`.
14. Commit only after the phase gate passes.
15. Merge to main only after CI passes.

## 2.4 Required completion report for every phase

Claude must end each phase with this exact structure:

```text
PHASE: <number and name>
STATUS: PASS | BLOCKED | FAIL
BRANCH: <branch>
COMMITS: <hashes>
SOURCES VERIFIED: <count and paths>
IMPLEMENTED: <short factual list>
TESTS RUN: <commands>
TEST RESULT: <passed, failed, skipped>
RUNTIME VALIDATION: <what was observed>
EVIDENCE: <file paths>
KNOWN LIMITATIONS: <none or explicit list>
NEXT PHASE ENTRY CRITERIA: SATISFIED | NOT SATISFIED
```

Claude must not continue automatically when the phase status is `BLOCKED` or `FAIL`.

## 2.5 Repository governance

Branch naming:

```text
phase/00-source-lock
phase/01-foundation
phase/02-signoz-foundry
phase/03-demo-system
phase/04-telemetry
phase/05-signoz-mcp-client
phase/06-trace-graph
phase/07-contract-engine
phase/08-baseline-mining
phase/09-application-core
phase/10-signoz-artifact-compiler
phase/11-release-gate
phase/12-ui-foundation
phase/13-contract-studio
phase/14-release-diff
phase/15-violation-inspector
phase/16-hardening
phase/17-release
```

Commit format:

```text
<type>(<scope>): <specific completed change>
```

Allowed examples:

```text
chore(repo): initialise strict pnpm workspace
feat(telemetry): emit versioned agent workflow spans
feat(graph): canonicalise trace trees deterministically
feat(contract): evaluate required ancestry rules
feat(signoz): compile violation dashboard through MCP
feat(gate): fail canary release on trajectory violations
```

Do not use vague commits such as `update`, `fix stuff`, `final`, or `changes`.

---

# 3. Product definition

## 3.1 Mission

Turn real SigNoz traces into executable behavioural contracts that prove an AI agent still follows approved execution paths when its model, prompt, tools, code, dependencies, or release changes.

## 3.2 Core problem

AI agent teams can observe latency, errors, token counts, tool calls, and final outputs, yet still miss a dangerous class of regression: the agent returns a plausible result after following a newly unsafe or unintended route.

Examples include:

- skipping a required fraud check before issuing a refund
- calling a side-effecting payment tool twice after a timeout
- writing to a customer database before completing an approval step
- using a new tool or service that was never part of the approved route
- entering a retry loop while eventually returning a successful response
- accessing a sensitive data domain through a new dependency
- removing a required human approval step
- silently changing from an idempotent operation to a non-idempotent operation
- producing the same final text with materially different cost, route length, or downstream impact

Output evaluation alone cannot reliably catch these failures because the answer can remain correct while the execution path becomes unsafe.

## 3.3 Product thesis

An AI agent release should be evaluated as a distributed execution graph, not only as a final response.

FlightRules uses SigNoz as the source of observable truth. It reconstructs complete traces, normalises their topology, mines known-good route families, turns approved behaviours into version-controlled contracts, evaluates new releases, writes violation telemetry back into SigNoz, creates SigNoz views, dashboards, and alerts, and exposes a release gate that can block a canary or CI workflow.

## 3.4 Category

Trajectory reliability and behavioural release governance for AI agents.

## 3.5 Primary value proposition

A team can answer all of the following from one release comparison:

- Which execution routes changed?
- Which required checks disappeared?
- Which side effects became duplicated?
- Which tools or services appeared for the first time?
- Which rules were violated?
- Which traces prove the violation?
- Did cost, latency, retries, or downstream errors regress at the same time?
- Should the release pass or fail?

## 3.6 Product claim

FlightRules turns SigNoz traces into testable release contracts.

## 3.7 Product principles

1. Deterministic enforcement. An LLM may explain evidence, but it cannot decide whether a contract passed.
2. SigNoz-native evidence. Every decision must link back to real trace, metric, or log evidence.
3. OpenTelemetry portability. Instrumentation must use standard attributes where standards exist and clearly namespaced custom attributes where they do not.
4. Structural privacy. The core product must work without storing raw prompts, model reasoning, tool arguments, or tool results.
5. Human approval of policy. Mining proposes contracts. A human approves them before enforcement.
6. Version control. Contracts are files that can be reviewed, diffed, and committed.
7. Reproducibility. A judge or developer must be able to recreate the SigNoz stack and demo from repository files.
8. Honest boundaries. FlightRules is a post-execution and canary release gate in v1. It must not claim synchronous runtime prevention from asynchronously ingested telemetry.
9. Evidence over summaries. The primary UI is a graph diff and rule evidence, not a chat window.
10. Composability. The contract format, evaluator, telemetry, CLI, MCP integration, and GitHub gate must remain separable and reusable.

## 3.8 Non-goals for P0

FlightRules P0 will not:

- replace SigNoz
- become a general observability backend
- collect or display chain-of-thought
- judge semantic answer quality
- provide a broad LLM evaluation platform
- act as an inline production authorisation system
- mutate an agent's production actions automatically
- repair infrastructure automatically
- train or fine-tune models
- support every agent framework through custom plugins
- provide enterprise multi-tenancy, billing, SSO, or role-based access control
- directly query internal ClickHouse tables unless an officially documented path is required and approved through an ADR
- depend on proprietary telemetry formats
- claim perfect causal reconstruction when the source instrumentation does not emit enough causal information

---

# 4. Target users and jobs

## 4.1 Primary persona: Agent platform engineer

Context: Owns one or more production agents and their tool integrations.

Jobs:

- establish what known-good behaviour looks like
- detect route changes between releases
- prevent unsafe canaries from promotion
- identify exact traces that prove a regression
- keep behavioural policy in version control

Success condition: A release that skips a required check or duplicates a side effect is failed with evidence before full production rollout.

## 4.2 Secondary persona: SRE or observability engineer

Context: Owns SigNoz, service reliability, alerting, and incident response.

Jobs:

- connect agent-level failures to downstream services and infrastructure
- create stable views and alerts without rebuilding them manually
- understand whether a service incident came from a new agent route
- inspect correlated logs and metrics from a trajectory violation

Success condition: A violation links directly to the relevant SigNoz trace, logs, service, dashboard panel, and release.

## 4.3 Secondary persona: AI safety or compliance engineer

Context: Defines checks that must occur before sensitive operations.

Jobs:

- express required ancestry and forbidden paths
- verify that a release still includes approval, policy, fraud, or privacy checks
- review proposed rules mined from real traces
- produce an auditable record of why a release passed or failed

Success condition: Required operational controls are represented as deterministic contract rules and tested against real runs.

## 4.4 Demo persona: Refund-agent maintainer

Context: Maintains an agent that reads refund policy, retrieves an order, checks fraud status, issues a refund, and notifies the customer.

Job: Prove that release v2 still follows the approved route from v1.

Failure discovered: v2 skips policy and fraud checks, retries the payment write after a timeout, and still returns a successful customer message.

---

# 5. Canonical demo story

The demo must remain deterministic and repeatable.

## 5.1 Known-good release

Release identifier: `refund-agent-v1`

Expected route:

```text
refund.request
  -> policy.retrieve
  -> order.lookup
  -> fraud.check
  -> refund.calculate
  -> payment.refund
  -> customer.notify
```

Required properties:

- `policy.retrieve` occurs exactly once
- `fraud.check` occurs exactly once
- both are ancestors or verified predecessors of `payment.refund`
- `payment.refund` occurs at most once
- `customer.notify` occurs only after a successful refund result
- no unapproved tool is called
- retry count is at most one for read-only tools
- retry count is zero for `payment.refund` in the baseline

## 5.2 Violating canary release

Release identifier: `refund-agent-v2`

Violating route:

```text
refund.request
  -> order.lookup
  -> payment.refund
  -> payment.refund
  -> customer.notify
```

Required injected faults:

- policy retrieval skipped
- fraud check skipped
- first payment response delayed or timed out
- payment call retried without an idempotency key or with a deliberately changed key in the unsafe scenario
- duplicate write observed by payment service
- customer message still says the refund succeeded

## 5.3 Required demo reveal

The final answer shown to the user is materially the same for v1 and v2.

FlightRules must then show:

```text
Release decision: FAIL
Violation rate: greater than configured threshold
Missing prerequisite: policy.retrieve
Missing prerequisite: fraud.check
Duplicate side effect: payment.refund observed twice
Unknown route: first seen in refund-agent-v2
Representative traces: linked to SigNoz
```

The presentation must establish that output evaluation would likely pass while trajectory evaluation fails.

---

# 6. Scope and priority

## 6.1 P0 submission scope

The hackathon submission is incomplete unless all P0 items work end to end:

1. Reproducible SigNoz installation through Foundry.
2. Repository contains `casting.yaml` and `casting.yaml.lock`.
3. SigNoz MCP Server is enabled and reachable.
4. Claude Code can connect to the SigNoz MCP Server for development inspection.
5. FlightRules backend connects to the same MCP Server using an official MCP client.
6. Instrumented refund-agent demo emits traces, metrics, and logs into SigNoz.
7. Baseline and canary releases are distinguishable through telemetry attributes.
8. Complete trace trees can be fetched and reconstructed.
9. Trace nodes are deduplicated by span ID.
10. Dynamic identifiers in span names and selected attributes are normalised.
11. Baseline route families can be captured from a selected time range or release.
12. A versioned YAML contract can be proposed, reviewed, validated, stored, and evaluated.
13. Required-step, required-ancestry, forbidden-step, cardinality, allowed-tool, retry, route, latency, and token budget rules work.
14. The evaluator emits deterministic pass or fail decisions and typed violations.
15. Evaluation telemetry is emitted back to SigNoz.
16. A SigNoz dashboard is created through MCP and populated with real FlightRules data.
17. At least one saved SigNoz trace view is created through MCP.
18. At least one SigNoz alert is created through MCP and proven to fire.
19. A release comparison shows baseline versus canary topology differences.
20. A violation inspector links to the original SigNoz trace.
21. A CLI or GitHub Action gate exits non-zero when release thresholds fail.
22. The seeded v1 passes and seeded v2 fails.
23. The UI uses the later-provided `design.md` without changing product copy or route purposes.
24. Unit, property, integration, end-to-end, security, and reproducibility tests pass.
25. README, architecture, runbook, demo script, and submission documentation are complete.

## 6.2 P1 after P0 is stable

- merge structurally similar route families using a configurable similarity threshold
- compare more than two releases
- contract suggestions from rare-path analysis
- GitHub pull request comment with graph-diff summary
- Slack notification template through SigNoz notification channels
- contract import and export
- multiple agents per project
- support OpenAI and Anthropic provider adapters in the demo harness
- support traces from an external user-provided agent without the demo topology
- explanation assistant that uses SigNoz MCP evidence but cannot change the deterministic decision

## 6.3 P2 future scope

- policy packs for payments, data access, human approval, and privileged tools
- temporal logic beyond parent and predecessor relationships
- asynchronous workflow correlation across traces
- contract learning across environments
- organisation-level policy inheritance
- runtime guard integration with a separate inline policy system
- pull-request behavioural impact prediction
- framework-specific instrumentation packages
- OpenTelemetry Collector processor or connector for high-volume evaluation

---

# 7. Product terminology

| Term | Definition |
|---|---|
| Agent | A named AI-driven system that invokes models, tools, workflows, or services. |
| Release | A version of an agent identified by deployment, commit, image, or explicit release ID. |
| Run | One observed agent workflow execution represented by one primary trace. |
| Trace graph | The normalised graph reconstructed from all spans, parent links, span links, and approved custom causal attributes. |
| Route | The ordered or causally connected execution structure taken by one run. |
| Route family | A set of runs with the same canonical fingerprint or accepted similarity. |
| Baseline | A human-approved set of known-good runs or route families. |
| Contract | A versioned collection of deterministic trajectory rules. |
| Rule | One testable constraint over a run, route, release, or aggregate. |
| Violation | A typed instance where observed evidence fails a contract rule. |
| Evaluation | A deterministic assessment of one run or one release against a contract. |
| Release gate | A threshold decision that returns pass or fail for CI or canary promotion. |
| SigNoz artifact | A dashboard, saved view, alert, or notification channel created or managed through SigNoz MCP. |
| Evidence | Trace IDs, span IDs, attributes, metrics, logs, and resource links supporting a decision. |
| Trajectory SLO | A release-level objective over agent execution structure and behaviour. |

---

# 8. Information architecture, routes, and product wording

The route structure below is mandatory unless an implementation constraint is documented and approved in an ADR.

## 8.1 Public landing route

Route: `/`

Hero eyebrow:

```text
Trajectory reliability for AI agents
```

Hero title:

```text
Your agent changed its route. FlightRules caught it.
```

Hero body:

```text
Turn SigNoz traces into executable release contracts. Catch skipped checks, duplicate side effects, unknown tool paths, retry loops, and behavioural drift before a canary reaches production.
```

Primary CTA:

```text
Open the live demo
```

Secondary CTA:

```text
View the architecture
```

Proof strip:

```text
OpenTelemetry-native
Powered by SigNoz
Deterministic release gates
No chain-of-thought required
```

Problem section title:

```text
The answer can stay correct while the agent becomes unsafe.
```

Problem section body:

```text
Output checks see what the agent said. FlightRules sees what it did, which tools ran, which checks disappeared, which side effects repeated, and which downstream services changed.
```

Mechanism section steps:

```text
1. Observe real runs in SigNoz
2. Approve known-good route families
3. Compile them into a trajectory contract
4. Compare every new release
5. Fail the release with trace-level evidence
```

Final CTA title:

```text
Make the execution path part of the release contract.
```

Final CTA button:

```text
Run the v1 vs v2 demo
```

## 8.2 Setup route

Route: `/setup`

Page title:

```text
Connect FlightRules to SigNoz
```

Page description:

```text
FlightRules reads trace evidence and creates dashboards, views, and alerts through the SigNoz MCP Server. Credentials stay on the server and are never exposed to the browser.
```

Steps:

1. Verify SigNoz URL.
2. Verify MCP liveness and readiness.
3. Verify API key through a read-only tool call.
4. Discover available MCP tools.
5. Verify OTLP ingestion endpoint.
6. Save a server-side connection profile.

Primary CTA:

```text
Verify connection
```

Success message:

```text
SigNoz is connected. Trace discovery and artifact creation are available.
```

Failure message:

```text
Connection verification failed. No settings were saved. Review the failed check and retry.
```

## 8.3 Projects route

Route: `/projects`

Title:

```text
Projects
```

Empty state:

```text
Create a project to group agents, contracts, releases, and SigNoz artifacts.
```

CTA:

```text
Create project
```

## 8.4 Project overview

Route: `/projects/[projectId]/overview`

Title pattern:

```text
<Project name> trajectory health
```

Required cards:

- active agents
- releases evaluated
- gate pass rate
- violating runs
- unknown routes
- duplicate side effects
- latest contract sync
- SigNoz connection status

Main panel title:

```text
Release decisions
```

Secondary panel title:

```text
Violations by rule
```

## 8.5 Agents list

Route: `/projects/[projectId]/agents`

Title:

```text
Agents
```

Empty state:

```text
Register an instrumented agent, then capture a known-good baseline from SigNoz.
```

CTA:

```text
Register agent
```

## 8.6 Agent detail

Route: `/projects/[projectId]/agents/[agentId]`

Tabs:

```text
Overview
Routes
Contracts
Releases
Violations
Telemetry
```

Primary CTA when no baseline exists:

```text
Capture baseline
```

Primary CTA when baseline exists:

```text
Evaluate release
```

## 8.7 Baseline capture

Route: `/projects/[projectId]/agents/[agentId]/baselines/new`

Title:

```text
Capture a known-good baseline
```

Description:

```text
Select a release and time window. FlightRules will fetch complete traces from SigNoz, normalise their topology, group route families, and propose a contract for review.
```

Required controls:

- release ID
- environment
- time range
- minimum completed runs
- include successful runs only toggle
- exclude traces with missing root span toggle
- rare route threshold
- maximum traces to fetch

Primary CTA:

```text
Analyse baseline
```

Progress states:

```text
Discovering traces
Fetching complete span trees
Normalising routes
Grouping route families
Proposing contract rules
```

## 8.8 Route family detail

Route: `/projects/[projectId]/agents/[agentId]/routes/[routeFamilyId]`

Title pattern:

```text
Route family <short fingerprint>
```

Required content:

- occurrence count
- share of baseline runs
- first and last observed
- canonical graph
- representative traces
- tools and services used
- side-effecting operations
- retries
- latency distribution
- token distribution when available
- actions: approve, reject, mark optional, exclude as fixture error

## 8.9 Contract Studio

Route: `/projects/[projectId]/agents/[agentId]/contracts/[contractId]`

Title:

```text
Trajectory contract
```

Status values:

```text
Draft
Approved
Active
Superseded
Invalid
```

Primary actions:

```text
Validate contract
Approve version
Sync to SigNoz
Export YAML
Evaluate against traces
```

Graph node rule controls:

```text
Required
Optional
Forbidden
Maximum calls
Must precede
Must descend from
Side effect
Sensitive data domain
```

Unsaved warning:

```text
This contract has unvalidated changes. Validate it before approval.
```

## 8.10 Releases list

Route: `/projects/[projectId]/agents/[agentId]/releases`

Title:

```text
Releases
```

Columns:

- release ID
- commit SHA
- environment
- first observed
- evaluated runs
- gate decision
- violation rate
- unknown route rate
- latency change
- token change

## 8.11 Release Diff

Route: `/projects/[projectId]/agents/[agentId]/releases/[releaseId]`

Title pattern:

```text
<release ID> vs <baseline release ID>
```

Decision copy:

```text
PASS: This release stayed within the approved trajectory contract.
FAIL: This release exceeded one or more trajectory thresholds.
INSUFFICIENT DATA: More completed runs are required before a release decision can be made.
ERROR: FlightRules could not complete the evaluation. No release decision was produced.
```

Required diff labels:

```text
Added step
Removed step
New edge
Missing edge
Cardinality changed
New tool
New service
New data domain
Retry increase
Latency regression
Token regression
Duplicate side effect
```

Primary actions:

```text
Open representative violation
Re-run evaluation
Download evidence
Open in SigNoz
```

## 8.12 Violation Inspector

Route: `/projects/[projectId]/violations/[violationId]`

Title pattern:

```text
<rule name> violated
```

Required sections:

```text
What failed
Observed route
Approved route
Trace evidence
Correlated logs
Downstream metrics
Release context
Rule definition
Evaluation record
```

Primary CTA:

```text
Open trace in SigNoz
```

Secondary actions:

```text
Open correlated logs
Inspect release diff
Copy evidence summary
```

The product must never offer `Ignore and pass release`. A user may create a new contract version or explicitly exclude a bad fixture, both of which produce an audit record.

## 8.13 SigNoz integration route

Route: `/projects/[projectId]/integrations/signoz`

Title:

```text
SigNoz integration
```

Required sections:

- connection status
- discovered tool capabilities
- telemetry field discovery
- managed dashboards
- managed alerts
- managed views
- notification channels
- sync history

Actions:

```text
Verify connection
Discover fields
Sync artifacts
Open SigNoz
```

## 8.14 Demo route

Route: `/demo`

Title:

```text
The answer stayed correct. The route did not.
```

Required controls:

```text
Run approved v1
Run unsafe v2
Capture baseline
Evaluate v2
Reset demo
```

The demo page must show the same customer-facing answer for both releases before revealing the trace difference.

---

# 9. Functional requirements

## FR-001 Project creation

The system must create a project with name, slug, description, environment defaults, and SigNoz connection profile reference.

Acceptance:

- duplicate slugs are rejected
- name and slug are validated server-side
- project creation is persisted
- project appears in the projects list

## FR-002 Agent registration

The system must register an agent with:

- display name
- stable agent key
- workflow name matcher
- service name matchers
- release attribute key
- environment attribute key
- optional root span matcher
- optional tool operation matcher
- expected trace completion criteria

Acceptance:

- field discovery uses the connected SigNoz tenant
- a preview query shows matching recent traces
- registration fails if no release discriminator is supplied

## FR-003 Trace discovery

The system must discover candidate runs by querying SigNoz through MCP.

Required behaviour:

- query by agent, release, environment, and time range
- paginate or batch safely
- never assume the first returned span is the root
- collect trace IDs, then fetch complete details for each trace
- retain MCP `webUrl` links when returned
- record incomplete trace failures separately

## FR-004 Trace graph reconstruction

For every fetched trace, FlightRules must:

- deduplicate spans by `span_id`
- identify the root or synthetic root
- preserve parent-child relationships
- preserve span links when available
- capture stable node labels
- capture service, operation, kind, status, start and end time
- capture approved low-cardinality attributes
- derive tool, side-effect, retry, release, environment, and data-domain classifications
- detect orphan spans and cycles
- output a deterministic serialisable graph

## FR-005 Name and attribute normalisation

FlightRules must normalise high-cardinality values before route fingerprinting.

Examples:

```text
/orders/98271/refund -> /orders/{id}/refund
customer-4f92c1 -> customer-{id}
run_01JAB... -> run_{id}
```

Normalisation rules must be explicit, ordered, testable, and versioned. Raw values may remain in protected evidence where safe, but may not affect canonical route identity unless configured.

## FR-006 Canonical route fingerprint

The same logical graph must produce the same fingerprint regardless of:

- input span order
- map or JSON key order
- irrelevant timestamp differences
- random trace and span IDs
- configured dynamic identifier values

The fingerprint must change when a contract-relevant node, edge, service, tool, side-effect classification, or configured attribute changes.

## FR-007 Baseline capture

A user must be able to capture a baseline from known-good traces.

The system must:

- enforce a minimum number of completed runs
- show rejected or incomplete runs
- group identical canonical fingerprints
- calculate family frequency
- select representative traces
- label rare families
- allow explicit approval or exclusion
- persist the approved baseline version

## FR-008 Contract proposal

From approved baseline families, the system must propose deterministic rules:

- steps present in all approved families
- required ancestry for side effects
- maximum observed cardinality with configurable safety margin
- known tools and services
- route-family allowlist
- observed retry limits
- latency and token budgets using configurable percentiles and margins
- sensitive domain observations

Every proposed rule must include its evidence basis and confidence calculation. No proposal becomes active without human approval.

## FR-009 Contract schema validation

Contracts must use a versioned YAML and JSON-compatible schema.

Validation must reject:

- unknown schema version
- duplicate rule IDs
- invalid selectors
- invalid threshold ranges
- contradictory rules detectable statically
- rules referencing undefined route families
- invalid units
- missing gate thresholds

## FR-010 Run evaluation

The evaluator must evaluate one trace graph against one approved contract and return:

- status: pass, fail, error, insufficient_data
- rule results
- typed violations
- evidence node and edge references
- route fingerprint
- similarity to nearest approved route
- evaluation duration
- evaluator version
- contract version

The evaluator must be deterministic for identical inputs.

## FR-011 Release evaluation

The evaluator must aggregate completed run evaluations by release and calculate:

- evaluated run count
- passed and failed run count
- violation rate
- unknown route rate
- duplicate side-effect rate
- missing prerequisite rate
- latency change from baseline
- token change from baseline
- retry change from baseline
- gate decision

## FR-012 Release gate

The gate must support:

- minimum completed run count
- maximum violation percentage
- maximum unknown route percentage
- zero-tolerance rule IDs
- latency regression threshold
- token regression threshold
- timeout while waiting for telemetry
- explicit `insufficient_data` exit code

Required CLI exit codes:

```text
0 = pass
2 = contract violation
3 = insufficient data
4 = integration or evaluation error
5 = invalid configuration
```

## FR-013 SigNoz saved-view compiler

FlightRules must create at least these saved views through MCP:

```text
FlightRules - violating runs
FlightRules - duplicate side effects
FlightRules - unknown routes
FlightRules - release comparison
```

Each created view must be read back and validated.

## FR-014 SigNoz dashboard compiler

FlightRules must create one managed dashboard through MCP with real queries and these required panels:

1. Release decisions over time
2. Violation rate by release
3. Violations by rule
4. Unknown route rate
5. Duplicate side effects
6. Evaluation duration p95
7. Agent run latency baseline versus canary
8. Token usage baseline versus canary
9. Retry count baseline versus canary
10. Latest violating traces table or linked list where supported

## FR-015 SigNoz alert compiler

FlightRules must create alerts through MCP for:

- trajectory violation rate above threshold
- duplicate side effect count greater than zero
- release evaluation errors
- no evaluation data during an active canary window

The implementation must verify notification channel names before alert creation.

## FR-016 Violation telemetry

FlightRules must emit its own telemetry to SigNoz using OTLP.

Required metrics and spans are defined in Section 17.

## FR-017 Evidence linking

Every violation must retain:

- trace ID
- relevant span IDs
- release ID
- contract ID and version
- rule ID
- SigNoz web URL when available
- safe evidence summary
- evaluation timestamp
- evaluator version

## FR-018 Contract lifecycle

Supported states:

```text
draft -> approved -> active -> superseded
```

Invalid contracts cannot be approved. Activating a new version supersedes the prior active version for the same agent and environment, while preserving all historical evaluations.

## FR-019 Audit history

The system must record:

- baseline creation
- route-family approval and exclusion
- contract creation and edits
- contract approval and activation
- SigNoz artifact sync
- evaluation runs
- gate decisions
- demo reset

## FR-020 Demo reset

The demo can be reset without deleting the SigNoz installation.

Reset must:

- clear FlightRules application data created by the demo
- remove or replace managed SigNoz artifacts safely
- retain source configuration
- reseed deterministic fixtures
- produce a clean v1 baseline and v2 canary sequence

---

# 10. Contract DSL

## 10.1 File location

Default contract path:

```text
contracts/<project-slug>/<agent-key>/<environment>/contract.yaml
```

## 10.2 Required top-level shape

```yaml
apiVersion: flightrules.dev/v1alpha1
kind: TrajectoryContract
metadata:
  id: refund-agent-production
  name: Refund Agent Production Contract
  version: 1.0.0
  project: demo-commerce
  agent: refund-agent
  environment: production
  createdAt: 2026-07-25T00:00:00Z
  baselineRelease: refund-agent-v1
spec:
  selectors:
    workflowName: refund-workflow
    releaseAttribute: agent.release.id
    environmentAttribute: deployment.environment.name
  approvedRoutes: []
  rules: []
  budgets: {}
  gate: {}
```

## 10.3 Selector model

A selector must identify spans using stable fields.

```yaml
selector:
  name: payment.refund
  service: payment-service
  operation: execute_tool
  attributes:
    gen_ai.tool.name: issue_refund
```

Supported selector operators in P0:

```text
equals
not_equals
in
not_in
exists
matches
```

Regex must be RE2-compatible or use a package with denial-of-service protection. Patterns must be length-limited.

## 10.4 Rule types

### Required span

```yaml
- id: require-fraud-check
  type: required_span
  selector:
    name: fraud.check
  cardinality:
    min: 1
    max: 1
  severity: critical
```

### Required ancestry

```yaml
- id: fraud-before-refund
  type: required_ancestry
  ancestor:
    name: fraud.check
  descendant:
    name: payment.refund
  relationship: any_depth
  severity: critical
```

### Required direct child

```yaml
- id: payment-result-before-notify
  type: required_edge
  from:
    name: payment.refund
  to:
    name: customer.notify
  relationship: direct
  severity: high
```

### Forbidden span

```yaml
- id: forbid-admin-write
  type: forbidden_span
  selector:
    attributes:
      agent.data_domain: admin
      agent.side_effect: write
  severity: critical
```

### Forbidden path

```yaml
- id: no-message-to-write-without-approval
  type: forbidden_path
  from:
    name: user.message
  to:
    attributes:
      agent.side_effect: write
  unless:
    contains:
      name: approval.verify
  severity: critical
```

### Cardinality

```yaml
- id: single-refund-write
  type: cardinality
  selector:
    name: payment.refund
  min: 0
  max: 1
  scope: run
  severity: critical
```

### Allowed tools

```yaml
- id: approved-tools-only
  type: allowed_values
  field: gen_ai.tool.name
  values:
    - retrieve_policy
    - lookup_order
    - check_fraud
    - issue_refund
    - notify_customer
  severity: high
```

### Attribute constraint

```yaml
- id: refund-must-be-idempotent
  type: attribute_constraint
  selector:
    name: payment.refund
  field: agent.idempotency.present
  operator: equals
  value: true
  severity: critical
```

### Retry budget

```yaml
- id: bounded-retries
  type: retry_budget
  selector:
    operation: execute_tool
  maxPerTool: 2
  maxRunTotal: 4
  sideEffectMax: 0
  severity: high
```

### Approved routes

```yaml
- id: approved-route-family
  type: approved_routes
  fingerprints:
    - sha256:...
    - sha256:...
  minSimilarity: 0.92
  severity: high
```

### Latency budget

```yaml
- id: run-latency
  type: numeric_budget
  metric: run.duration_ms
  aggregation: p95
  max: 8000
  scope: release
  severity: medium
```

### Token budget

```yaml
- id: output-token-budget
  type: numeric_budget
  metric: gen_ai.usage.output_tokens
  aggregation: p95
  max: 1200
  scope: release
  severity: medium
```

## 10.5 Gate definition

```yaml
spec:
  gate:
    minCompletedRuns: 20
    evaluationTimeoutSeconds: 600
    maxViolationPercent: 0.5
    maxUnknownRoutePercent: 1.0
    maxLatencyRegressionPercent: 20
    maxTokenRegressionPercent: 25
    zeroToleranceRuleIds:
      - require-fraud-check
      - fraud-before-refund
      - single-refund-write
      - refund-must-be-idempotent
```

## 10.6 Contract explanation limits

Claude or another LLM may generate a natural-language explanation from an evaluation. The explanation must:

- cite the deterministic result
- identify exact rule IDs
- link to trace evidence
- never change pass to fail or fail to pass
- never invent missing spans or causes
- be labelled `Generated explanation`

The product remains fully functional without an explanation model.

---

# 11. Trace graph model and algorithms

## 11.1 Input guarantees and uncertainty

A SigNoz trace is primarily a tree through parent span IDs, but span links and asynchronous workflows can introduce causal relationships outside the tree.

FlightRules must distinguish:

- observed parent-child relationship
- observed span link
- explicit custom predecessor relationship
- inferred timestamp order

Timestamp order is weak evidence and must not be treated as causal truth by default.

## 11.2 Graph node shape

```ts
type TraceNode = {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  canonicalName: string;
  serviceName: string;
  operationName: string | null;
  spanKind: string | null;
  statusCode: string | null;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  durationNano: bigint;
  attributes: Record<string, SafeScalar | SafeScalar[]>;
  toolName: string | null;
  toolType: string | null;
  sideEffect: "none" | "read" | "write" | "external" | "unknown";
  dataDomain: string | null;
  retryNumber: number | null;
  releaseId: string | null;
  environment: string | null;
};
```

The implementation may refine this type, but all fields above must be represented or intentionally mapped.

## 11.3 Graph edge types

```text
parent
span_link
explicit_predecessor
```

`inferred_time_order` may be computed for display but cannot satisfy a critical causal rule unless the contract explicitly permits it.

## 11.4 Root selection

Use this order:

1. one span with no parent and matching the configured root selector
2. one span with no parent and earliest start time
3. synthetic root connected to all orphan roots

Multiple roots must be recorded as a trace-quality warning.

## 11.5 Deduplication

Deduplicate by the tuple `(trace_id, span_id)`.

If duplicate records disagree:

- prefer the record with the most complete attribute set only when core identity fields match
- otherwise mark the trace inconsistent and exclude it from baseline mining
- preserve diagnostic evidence

## 11.6 Normalisation pipeline

Normalisation order:

1. trim and Unicode-normalise names
2. map configured aliases
3. replace known UUIDs
4. replace ULIDs
5. replace long hex identifiers
6. replace numeric path segments where configured
7. replace configured customer, order, run, or session identifiers
8. lower-case fields configured as case-insensitive
9. remove configured volatile attributes
10. classify service, tool, side effect, and data domain

The normalisation configuration must have its own version and hash. Every stored route fingerprint must retain the normaliser version.

## 11.7 Canonical serialisation

Canonical output must:

- sort nodes by canonical structural path, then stable label
- sort attributes by key
- sort set-valued attributes
- exclude trace ID, span ID, timestamps, and volatile values from the fingerprint
- include contract-relevant edge types
- include selected stable attributes

Use SHA-256 over the canonical serialisation.

## 11.8 Baseline route families

P0 grouping is exact by fingerprint.

Each family stores:

- fingerprint
- canonical graph
- count
- percentage
- representative trace IDs
- first and last observed
- average and percentile latency
- average and percentile input and output tokens
- tool set
- service set
- side-effect set
- trace-quality warnings

P1 may merge similar families only after exact grouping is correct.

## 11.9 Similarity score

P0 may calculate a deterministic weighted Jaccard score for display and nearest-family selection.

Feature sets:

- node labels
- direct edges
- ancestor pairs for configured critical nodes
- tool names
- service names
- side-effect labels
- selected attribute facts

Recommended weights:

```text
critical required node: 5
critical edge or ancestry pair: 5
side-effect node: 5
tool node: 3
service node: 2
ordinary node: 1
```

The exact formula must be documented and property-tested.

## 11.10 Typed graph diff

A graph diff must produce structured changes:

```text
node_added
node_removed
edge_added
edge_removed
cardinality_changed
tool_added
service_added
data_domain_added
side_effect_duplicated
retry_increased
attribute_changed
route_unknown
```

Every change references observed nodes and the nearest approved family.

## 11.11 Evaluation order

Evaluate one run in this order:

1. graph validity
2. required span rules
3. forbidden span rules
4. cardinality rules
5. edge and ancestry rules
6. attribute constraints
7. allowed tool and service rules
8. retry rules
9. approved route rules
10. numeric run budgets

Release-level numeric budgets are evaluated after run-level results are stored.

## 11.12 Determinism requirement

For the same:

- trace graph
- contract version
- normaliser version
- evaluator version

FlightRules must return byte-equivalent canonical evaluation JSON except for explicitly excluded runtime metadata such as completion timestamp.

Property tests must prove ordering independence.

---

# 12. Technical architecture

## 12.1 Architecture overview

```text
Instrumented agent and demo services
        |
        | OTLP traces, metrics, logs
        v
SigNoz OTel ingestion deployed by Foundry
        |
        v
SigNoz traces, metrics, logs
        |
        | SigNoz MCP Server
        v
FlightRules SigNoz MCP client
        |
        +--> trace discovery and trace detail retrieval
        +--> field discovery
        +--> dashboard creation
        +--> saved-view creation
        +--> alert creation
        +--> resource read-back verification
        |
        v
FlightRules API and worker
        |
        +--> graph engine
        +--> baseline miner
        +--> contract compiler
        +--> evaluator
        +--> release gate
        +--> application PostgreSQL
        |
        +--> OTLP evaluation telemetry back to SigNoz
        |
        v
FlightRules web application and CLI/GitHub gate
```

## 12.2 Technology choices

Claude must verify current compatibility before pinning versions.

Preferred stack:

- TypeScript with strict mode
- supported Node.js LTS verified during Phase 0
- pnpm workspaces
- Next.js for web UI
- Fastify for API
- PostgreSQL for application state
- Drizzle ORM or another typed migration-first ORM after Phase 0 comparison
- official Model Context Protocol TypeScript SDK for MCP client behaviour
- OpenTelemetry JavaScript SDK 2.x-compatible APIs
- OTLP over HTTP for local simplicity unless gRPC is proven more reliable in the chosen stack
- Pino for structured logs with trace correlation
- Vitest for unit and integration tests
- fast-check for property-based tests
- Playwright for end-to-end tests
- Zod or JSON Schema-backed validation for external inputs
- a small job runner backed by PostgreSQL, selected and pinned after verification

Do not add Redis unless a proven requirement emerges.

## 12.3 Application boundaries

### Web

Responsibilities:

- server-rendered or hybrid product UI
- no direct SigNoz credentials
- no direct MCP calls from the browser
- calls FlightRules API only
- graph visualisation
- accessible forms and tables

### API

Responsibilities:

- validation
- projects, agents, baselines, contracts, releases, violations
- start jobs
- return job state
- expose gate results
- protect secrets

### Worker

Responsibilities:

- fetch traces through MCP
- reconstruct graphs
- mine baselines
- evaluate traces and releases
- compile SigNoz artifacts
- emit evaluation telemetry
- manage retries and idempotency

### CLI

Responsibilities:

- validate config and contracts
- trigger baseline or release evaluation
- wait for telemetry
- print machine-readable and human-readable results
- return documented exit codes

### Demo system

Responsibilities:

- produce real distributed telemetry
- run deterministic baseline and unsafe canary scenarios
- provide optional real LLM provider adapters
- remain fully testable in scripted mode

## 12.4 SigNoz access boundary

P0 must use the official SigNoz MCP Server for product reads and SigNoz artifact writes.

Direct SigNoz HTTP APIs may be used only when:

1. an official MCP tool cannot express a P0 requirement
2. the endpoint is documented or present in the pinned OpenAPI schema
3. an ADR explains why MCP was insufficient
4. tests cover the endpoint

Direct ClickHouse access is prohibited in P0.

## 12.5 Foundry boundary

Foundry owns the SigNoz deployment and generated lock file.

FlightRules application services may use a separate Compose file unless official Foundry documentation proves a stable supported way to include custom services. Do not invent custom mouldings.

Required repository files:

```text
casting.yaml
casting.yaml.lock
pours/                 # generated, commit policy decided in Phase 0
compose.app.yaml
.env.example
Makefile
```

## 12.6 Runtime modes

```text
scripted-demo
live-provider-demo
external-agent
```

`scripted-demo` must require no paid API key and must be the mode used by automated tests.

`live-provider-demo` may use Anthropic or OpenAI through adapters. It must not be required for product correctness.

`external-agent` allows a user to register existing trace selectors.

---

# 13. Repository structure

```text
/
  apps/
    web/
    api/
    worker/
    cli/
    demo-agent/
    demo-services/
      policy-service/
      order-service/
      fraud-service/
      payment-service/
      notification-service/
  packages/
    config/
    db/
    domain/
    telemetry/
    signoz-mcp/
    trace-graph/
    normaliser/
    contract-schema/
    contract-engine/
    baseline-miner/
    artifact-compiler/
    test-fixtures/
    ui/
  contracts/
    demo-commerce/
  docs/
    PRD.md
    ARCHITECTURE.md
    THREAT_MODEL.md
    RUNBOOK.md
    DEMO_SCRIPT.md
    SUBMISSION.md
    ACCEPTANCE_MATRIX.md
    research/
      source-lock.md
      compatibility-matrix.md
      mcp-capabilities.json
      otel-attributes.md
    adr/
    evidence/
  scripts/
    bootstrap.sh
    verify-environment.sh
    seed-demo.sh
    run-demo-v1.sh
    run-demo-v2.sh
    reset-demo.sh
    verify-reproducibility.sh
  .github/
    workflows/
      ci.yml
      release-gate.yml
  casting.yaml
  casting.yaml.lock
  compose.app.yaml
  design.md
  CLAUDE.md
  Makefile
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  tsconfig.base.json
  .env.example
  README.md
```

`docs/PRD.md` in the repository may be this file copied verbatim.

---

# 14. Data model

Every table requires created and updated timestamps where relevant. IDs should be UUIDv7 or another sortable format selected consistently.

## 14.1 projects

```text
id
name
slug
description
signoz_connection_id
default_environment
created_at
updated_at
```

## 14.2 signoz_connections

```text
id
name
base_url
mcp_url
api_key_secret_reference
status
last_verified_at
capabilities_json
created_at
updated_at
```

The API key value must not be stored in plaintext in the database for P0. Prefer environment secret reference. If encrypted storage is added, document key management.

## 14.3 agents

```text
id
project_id
name
agent_key
workflow_name_matcher
root_span_matcher_json
service_matchers_json
release_attribute_key
environment_attribute_key
normaliser_config_id
created_at
updated_at
```

## 14.4 releases

```text
id
agent_id
release_key
commit_sha
image_digest
environment
first_observed_at
last_observed_at
metadata_json
created_at
```

## 14.5 trace_runs

```text
id
agent_id
release_id
trace_id
signoz_web_url
root_span_id
started_at
completed_at
duration_ms
status
quality_status
raw_summary_json
created_at
```

Raw full traces do not need permanent storage in P0. Store safe canonical evidence and refetch through SigNoz when required.

## 14.6 trace_graphs

```text
id
trace_run_id
normaliser_version
graph_schema_version
fingerprint
canonical_graph_json
feature_set_json
quality_warnings_json
created_at
```

## 14.7 baseline_versions

```text
id
agent_id
release_id
environment
status
source_time_start
source_time_end
minimum_runs
approved_at
created_at
```

## 14.8 route_families

```text
id
baseline_version_id
fingerprint
canonical_graph_json
occurrence_count
occurrence_percent
status
representative_trace_ids_json
statistics_json
created_at
```

## 14.9 contracts

```text
id
agent_id
baseline_version_id
name
semantic_version
schema_version
status
yaml_text
canonical_json
content_hash
approved_at
activated_at
created_at
updated_at
```

## 14.10 contract_rules

```text
id
contract_id
rule_key
rule_type
severity
rule_json
evidence_basis_json
created_at
```

## 14.11 evaluations

```text
id
contract_id
release_id
scope
status
evaluator_version
normaliser_version
started_at
completed_at
summary_json
created_at
```

## 14.12 run_evaluations

```text
id
evaluation_id
trace_run_id
status
nearest_route_family_id
similarity_score
result_json
created_at
```

## 14.13 violations

```text
id
run_evaluation_id
rule_key
violation_type
severity
message
evidence_json
signoz_web_url
created_at
```

## 14.14 signoz_artifacts

```text
id
project_id
agent_id
artifact_type
managed_name
signoz_resource_id
signoz_web_url
spec_hash
last_synced_at
last_verified_at
status
remote_snapshot_json
created_at
updated_at
```

## 14.15 jobs

```text
id
job_type
entity_type
entity_id
status
attempt
idempotency_key
input_json
result_json
error_json
started_at
completed_at
created_at
```

## 14.16 audit_events

```text
id
project_id
actor_type
actor_id
event_type
entity_type
entity_id
details_json
created_at
```

---

# 15. API requirements

All API errors use a typed envelope:

```json
{
  "error": {
    "code": "TRACE_FETCH_FAILED",
    "message": "FlightRules could not fetch complete trace details.",
    "requestId": "...",
    "details": {}
  }
}
```

## 15.1 Health

```text
GET /health/live
GET /health/ready
GET /health/dependencies
```

Readiness must fail when the database is unavailable. SigNoz may be reported as degraded without taking down read-only local pages.

## 15.2 Setup and SigNoz

```text
POST /api/setup/signoz/verify
GET  /api/setup/signoz/capabilities
POST /api/setup/signoz/discover-fields
POST /api/setup/signoz/sync-artifacts
GET  /api/setup/signoz/artifacts
```

## 15.3 Projects

```text
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId
```

Deletion requires explicit confirmation and must not automatically delete SigNoz artifacts without a separate option.

## 15.4 Agents

```text
GET   /api/projects/:projectId/agents
POST  /api/projects/:projectId/agents
GET   /api/agents/:agentId
PATCH /api/agents/:agentId
POST  /api/agents/:agentId/preview-traces
```

## 15.5 Baselines

```text
POST /api/agents/:agentId/baselines
GET  /api/agents/:agentId/baselines
GET  /api/baselines/:baselineId
POST /api/baselines/:baselineId/route-families/:familyId/approve
POST /api/baselines/:baselineId/route-families/:familyId/exclude
POST /api/baselines/:baselineId/propose-contract
```

Long-running endpoints return a job ID.

## 15.6 Contracts

```text
GET  /api/agents/:agentId/contracts
POST /api/agents/:agentId/contracts
GET  /api/contracts/:contractId
PUT  /api/contracts/:contractId
POST /api/contracts/:contractId/validate
POST /api/contracts/:contractId/approve
POST /api/contracts/:contractId/activate
POST /api/contracts/:contractId/sync-signoz
GET  /api/contracts/:contractId/export
```

## 15.7 Evaluations and releases

```text
POST /api/agents/:agentId/evaluations
GET  /api/evaluations/:evaluationId
GET  /api/agents/:agentId/releases
GET  /api/releases/:releaseId
GET  /api/releases/:releaseId/diff
POST /api/releases/:releaseId/re-evaluate
GET  /api/releases/:releaseId/gate
```

## 15.8 Violations

```text
GET /api/projects/:projectId/violations
GET /api/violations/:violationId
GET /api/violations/:violationId/evidence
```

## 15.9 Demo

```text
POST /api/demo/reset
POST /api/demo/run/v1
POST /api/demo/run/v2
POST /api/demo/capture-baseline
POST /api/demo/evaluate-v2
GET  /api/demo/status
```

Demo mutation endpoints must be disabled in production unless `DEMO_MODE=true`.

## 15.10 Jobs

```text
GET /api/jobs/:jobId
GET /api/jobs/:jobId/events
```

Server-sent events may be used for progress. WebSockets are not required.

---

# 16. SigNoz integration specification

## 16.1 Foundry installation

Claude must use the current official Foundry installation path.

Expected verified flow at the source-baseline date:

```text
curl -fsSL https://signoz.io/foundry.sh | bash
foundryctl gauge -f casting.yaml
foundryctl forge -f casting.yaml
foundryctl cast -f casting.yaml
```

The current supported Docker casting shape must be verified before use.

The repository must not use SigNoz's deprecated legacy install script or deprecated bundled Compose deployment.

## 16.2 Casting requirements

The casting must:

- target Docker Compose for local and judge reproducibility
- enable SigNoz MCP Server
- expose SigNoz UI, OTLP gRPC, OTLP HTTP, and MCP ports as required
- pin compatible component versions after Phase 0 verification
- generate `casting.yaml.lock`
- pass `foundryctl gauge`
- pass `foundryctl forge`
- pass `foundryctl cast`

Initial conceptual shape, to be replaced by verified fields:

```yaml
apiVersion: v1alpha1
kind: Installation
metadata:
  name: flightrules-signoz
spec:
  deployment:
    flavor: compose
    mode: docker
  mcp:
    spec:
      enabled: true
```

Claude must not copy this blindly. It must compare it with the installed Foundry schema and generated examples.

## 16.3 MCP connection

For self-hosted HTTP mode, the FlightRules server must connect to:

```text
http://<mcp-host>:8000/mcp
```

and send the SigNoz API key through the supported authentication mechanism.

The browser must never receive the API key.

Claude Code development connection should use project scope where practical:

```text
claude mcp add --scope project --transport http signoz http://localhost:8000/mcp --header "SIGNOZ-API-KEY: <key>"
```

The exact current Claude Code syntax must be verified before execution.

## 16.4 Required MCP capability discovery

During setup, FlightRules must discover and record the available tool list. At minimum, P0 expects equivalents of:

```text
signoz_get_field_keys
signoz_get_field_values
signoz_search_traces
signoz_get_trace_details
signoz_aggregate_traces
signoz_search_logs
signoz_list_services
signoz_list_views
signoz_get_view
signoz_create_view
signoz_update_view
signoz_list_dashboards
signoz_get_dashboard
signoz_create_dashboard
signoz_update_dashboard
signoz_list_alert_rules
signoz_get_alert
signoz_create_alert
signoz_update_alert
signoz_get_alert_history
signoz_list_notification_channels
signoz_execute_builder_query
```

Tool absence must be handled as a capability failure, not hidden.

## 16.5 MCP read-before-write rules

Before creating or updating a resource:

1. read the relevant MCP resource instructions when the server exposes them
2. list existing resources to avoid name collision
3. verify notification channel names before creating alerts
4. create or update the resource
5. fetch it again by ID
6. compare required fields with the desired spec
7. store the remote ID, URL, spec hash, and snapshot

Partial update bodies must not be sent to endpoints or tools that replace the full resource.

## 16.6 Trace discovery flow

1. Discover relevant field keys.
2. Confirm observed release and environment values.
3. Search for spans matching the root or workflow selector.
4. Collect unique trace IDs.
5. Fetch complete trace details for each trace.
6. Deduplicate spans.
7. Record SigNoz `webUrl` links.
8. Exclude incomplete or inconsistent traces from baseline mining.
9. Store safe summaries and canonical graphs.

## 16.7 Trace Matching use

Rules expressible through SigNoz Trace Matching should also be compiled into saved views where practical.

Examples:

```text
A => B
A -> B
A && B
A || B
A NOT B
```

FlightRules must preserve parentheses explicitly in combined expressions because operator precedence differs from ordinary Boolean expectations.

The deterministic evaluator remains the source of the release decision. SigNoz views provide native investigation and alerting surfaces.

## 16.8 Managed resource names

Use deterministic names:

```text
FlightRules / <project> / <agent> / Contract Health
FlightRules / <project> / <agent> / Violating Runs
FlightRules / <project> / <agent> / Duplicate Side Effects
FlightRules / <project> / <agent> / Unknown Routes
FlightRules / <project> / <agent> / Violation Rate Alert
```

Managed resources must include identifying tags or descriptions where supported.

## 16.9 Compatibility policy

The source-baseline research observed SigNoz v0.134.0 as the latest release on 22 July 2026, while MCP write-tool minimum versions vary by feature. Claude must verify the actual installed version and tool compatibility before pinning.

The app must expose a compatibility page showing:

- SigNoz version
- Foundry version
- MCP server version
- OpenTelemetry SDK version
- supported and missing tools
- last verified time

---

# 17. OpenTelemetry and FlightRules telemetry

## 17.1 Standard attributes

Use current released OpenTelemetry semantic conventions where available.

Expected standard fields include:

```text
service.name
deployment.environment.name
service.version
service.instance.id
gen_ai.operation.name
gen_ai.workflow.name
gen_ai.agent.name
gen_ai.tool.name
gen_ai.tool.type
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
error.type
```

Claude must verify exact released names and stability before implementation.

## 17.2 FlightRules custom namespace

Use `flight_rules.*` for FlightRules evaluator telemetry.

Use `agent.*` only for application-specific agent metadata where no stable standard exists.

Required demo attributes:

```text
agent.release.id
agent.run.id
agent.step.category
agent.side_effect
agent.data_domain
agent.retry.number
agent.idempotency.present
agent.idempotency.key_hash
agent.contract.id
agent.scenario
vcs.commit.sha
```

Do not store raw idempotency keys. Hash them with a one-way keyed or salted method suitable for correlation.

## 17.3 Required FlightRules spans

```text
flight_rules.fetch_traces
flight_rules.reconstruct_trace
flight_rules.normalise_graph
flight_rules.mine_baseline
flight_rules.propose_contract
flight_rules.evaluate_run
flight_rules.evaluate_release
flight_rules.compile_signoz_artifacts
flight_rules.release_gate
```

Required attributes:

```text
flight_rules.project.id
flight_rules.agent.id
flight_rules.contract.id
flight_rules.contract.version
flight_rules.release.id
flight_rules.evaluation.id
flight_rules.evaluation.status
flight_rules.violation.count
flight_rules.route.fingerprint
flight_rules.route.similarity
flight_rules.gate.decision
```

## 17.4 Required metrics

Use suitable counters and histograms, with exact instrument names verified against current OTel naming guidance.

Conceptual metrics:

```text
flight_rules.evaluations
flight_rules.evaluation.duration
flight_rules.violations
flight_rules.unknown_routes
flight_rules.duplicate_side_effects
flight_rules.release_gate.decisions
flight_rules.trace_fetch.failures
flight_rules.signoz_artifact_sync
flight_rules.route.similarity
```

Required dimensions must remain low cardinality:

```text
project slug
agent key
release key when bounded in demo
rule type
severity
decision
status
artifact type
```

Do not use trace IDs, span IDs, full error messages, user IDs, or raw prompts as metric labels.

## 17.5 Logs

All application logs must be structured JSON in non-development environments.

Required fields:

```text
timestamp
level
service.name
message
request_id
trace_id when available
span_id when available
job_id when available
evaluation_id when available
error.code when available
```

Secrets and sensitive tool payloads must be redacted before logging.

## 17.6 Prompt and tool-content privacy

By default, do not record:

```text
gen_ai.input.messages
gen_ai.output.messages
gen_ai.tool.call.arguments
gen_ai.tool.call.result
raw prompts
raw tool results
chain-of-thought
```

The product demo must prove that trajectory enforcement works without them.

---

# 18. Security and privacy requirements

## 18.1 Threats to address

- SigNoz API key exposure
- arbitrary MCP tool invocation from browser input
- YAML parser abuse
- regex denial of service
- stored cross-site scripting in span attributes
- unsafe external URLs
- trace data containing secrets
- SQL injection through application queries
- job replay
- duplicate artifact creation
- contract tampering
- path traversal during contract export
- unbounded trace fetches
- high-cardinality telemetry explosion
- demo endpoints exposed in production
- server-side request forgery through configurable SigNoz URLs

## 18.2 Required controls

- secrets remain server-side
- allowlist SigNoz URL schemes and block loopback or metadata IPs when running in hosted multi-user mode
- local self-host mode may explicitly permit configured local addresses
- strict request validation
- safe YAML loader with aliases disabled or constrained
- input size limits
- regex length and execution limits
- HTML escaping for all telemetry-derived text
- URL validation before rendering external links
- parameterised database access
- idempotency keys on long-running jobs
- rate limits on demo and evaluation endpoints
- maximum traces per evaluation
- maximum spans per trace with explicit error state
- contract content hashes
- audit events for contract changes
- dependency scanning
- secret scanning
- container images run as non-root where feasible
- no public MCP port in production deployment
- demo mutation routes disabled outside demo mode

## 18.3 Data retention

P0 stores canonical graphs and safe evidence summaries. Full raw trace payloads remain in SigNoz and are fetched when needed.

A retention setting must permit deletion of:

- local trace summaries
- canonical graphs
- evaluations
- violations
- audit history only through an explicit administrative operation

Contract files and release decisions must not be deleted as a side effect of trace retention cleanup.

---

# 19. Error model

Required error codes include:

```text
CONFIG_INVALID
SIGNOZ_UNREACHABLE
SIGNOZ_AUTH_FAILED
MCP_UNAVAILABLE
MCP_TOOL_MISSING
MCP_RESPONSE_INVALID
TRACE_QUERY_FAILED
TRACE_FETCH_FAILED
TRACE_INCOMPLETE
TRACE_INCONSISTENT
TRACE_TOO_LARGE
GRAPH_INVALID
NORMALISATION_FAILED
CONTRACT_INVALID
CONTRACT_CONFLICT
BASELINE_INSUFFICIENT_RUNS
EVALUATION_FAILED
RELEASE_INSUFFICIENT_DATA
ARTIFACT_CREATE_FAILED
ARTIFACT_VERIFY_FAILED
ALERT_DID_NOT_FIRE
JOB_ALREADY_RUNNING
DEMO_DISABLED
```

Errors must be actionable and must not leak secrets.

---

# 20. Quality attributes

## 20.1 Reliability

- jobs are idempotent
- evaluation retries do not duplicate stored results
- MCP write retries do not create duplicate managed resources
- worker restarts resume or safely fail jobs
- the release gate never returns pass after an internal error

## 20.2 Performance targets for P0

On the supported local environment:

- evaluate a 100-span trace in less than 250 ms p95, excluding network fetch
- canonicalise a 1,000-span trace in less than 1 second p95
- evaluate 100 fetched traces in less than 30 seconds after data is available, excluding SigNoz query latency
- render a 500-node graph without blocking the main UI thread for more than 200 ms continuously
- API p95 under 500 ms for non-job endpoints on local deployment

These are targets, not claims, until measured.

## 20.3 Accessibility

- keyboard-accessible navigation
- visible focus states
- graph has a table or list alternative
- status is not conveyed by colour alone
- forms have explicit labels and error associations
- minimum WCAG AA contrast after `design.md` is applied
- reduced-motion support

## 20.4 Browser support

Latest stable Chrome, Firefox, and Safari at release time. Claude must record tested versions.

---

# 21. Phase-by-phase implementation plan

# Phase 00: Source lock and feasibility proof

## Objective

Prove the current official SigNoz, Foundry, MCP, OpenTelemetry, Claude Code, Node.js, and package surfaces before creating application code.

## Entry criteria

- empty or newly created repository
- this PRD available as `docs/PRD.md`
- internet access for official documentation and repositories

## Tasks

1. Create `docs/research/source-lock.md`.
2. Record current date and environment details.
3. Verify the latest stable SigNoz release and compatible Foundry default.
4. Verify current Foundry installation commands.
5. Generate official Foundry examples locally.
6. inspect the current casting schema and MCP enablement fields.
7. Verify `casting.yaml.lock` generation behaviour.
8. Verify SigNoz MCP Server installation, authentication, liveness, readiness, and supported tools.
9. Verify minimum SigNoz versions for dashboard, alert, view, and trace tools.
10. Verify current OpenTelemetry JavaScript SDK APIs and GenAI semantic conventions.
11. Verify current Node.js LTS and package compatibility.
12. Verify the official MCP TypeScript SDK client APIs.
13. Record versions in `docs/research/compatibility-matrix.md`.
14. Create an initial architecture ADR selecting the stack.
15. Create `CLAUDE.md` containing the operating contract from this PRD.

## Tests and validation

- all source URLs open
- all pinned repositories or packages resolve
- Foundry CLI runs `--version`
- official example generation succeeds
- no selected dependency is archived or incompatible
- a minimal MCP client can initialise against a local or temporary server fixture

## Evidence

```text
docs/evidence/phase-00-result.md
docs/research/source-lock.md
docs/research/compatibility-matrix.md
docs/adr/0001-stack-and-version-policy.md
```

## Exit gate

No application coding begins until every P0 dependency has a verified source and selected version policy.

# Phase 01: Repository foundation and CI

## Objective

Create a strict, testable monorepo with no product logic.

## Tasks

1. Initialise pnpm workspace.
2. Add TypeScript strict base configuration.
3. Create the repository structure.
4. Add linting, formatting, type checking, unit test, build, and dependency-audit commands.
5. Configure environment validation.
6. Add `.env.example` with no secrets.
7. Add PostgreSQL development service in `compose.app.yaml`.
8. Add database migration tooling.
9. Add CI workflow.
10. Add secret scanning and dependency scanning.
11. Add conventional commit guidance.
12. Add `Makefile` targets:

```text
make verify-env
make install
make lint
make typecheck
make test
make test-integration
make test-e2e
make build
make up
make down
```

## Tests and validation

- clean install from lock file
- lint passes
- typecheck passes
- empty test suites are not accepted, add foundation tests
- package builds pass
- database migration up and down pass
- CI runs on a test branch

## Exit gate

A fresh clone can install, validate environment, build, and run foundation tests without undocumented manual steps.

# Phase 02: SigNoz deployment through Foundry

## Objective

Create the reproducible SigNoz and MCP deployment required by the hackathon.

## Tasks

1. Generate a current Docker Compose casting example.
2. Create verified `casting.yaml`.
3. Enable MCP using verified schema.
4. Pin compatible versions where the schema permits.
5. Run `foundryctl gauge`.
6. Run `foundryctl forge`.
7. inspect generated files for expected ports and services.
8. Run `foundryctl cast`.
9. Verify SigNoz UI health.
10. Verify OTLP gRPC and HTTP ports.
11. Verify MCP `/livez` and `/readyz`.
12. Complete the documented first-user and API-key setup.
13. Connect Claude Code to the project-scoped SigNoz MCP Server.
14. Run MCP tool discovery.
15. Commit `casting.yaml` and `casting.yaml.lock`.
16. Add `scripts/verify-signoz.sh`.
17. Add teardown and data-reset documentation.

## Tests and validation

- `foundryctl gauge -f casting.yaml` passes
- `foundryctl forge -f casting.yaml` passes
- lock file is generated and stable on a second forge
- `foundryctl cast -f casting.yaml` starts healthy services
- UI returns success
- OTLP endpoint accepts sample telemetry
- MCP liveness and readiness pass
- authenticated MCP read tool succeeds
- wrong API key fails
- MCP port is not exposed in the production Compose profile

## Exit gate

A fresh supported machine can deploy the pinned SigNoz stack from `casting.yaml`, and the lock file reproduces the same resolved configuration.

# Phase 03: Deterministic demo system

## Objective

Build a real distributed refund-agent topology that can produce approved and unsafe routes.

## Tasks

1. Build the policy service.
2. Build the order service.
3. Build the fraud service.
4. Build the payment service with an idempotency ledger.
5. Build the notification service.
6. Build the demo agent orchestrator.
7. Add provider interface:

```text
scripted
anthropic optional
openai optional
```

8. Implement `refund-agent-v1` approved route.
9. Implement `refund-agent-v2` unsafe route.
10. Ensure both return materially the same customer-facing answer.
11. Add deterministic fault injection for payment timeout and duplicate write.
12. Add reset endpoints restricted to demo mode.
13. Add request and run IDs.
14. Add compose services and health checks.

## Tests and validation

- each service unit-tested
- v1 calls every required service once
- v2 skips policy and fraud
- v2 calls payment twice in the unsafe fixture
- payment service records duplicate effect in unsafe fixture
- customer-facing responses remain equivalent
- reset returns system to known state
- no LLM API key required for tests

## Exit gate

The demo topology reliably creates one safe route and one unsafe route before telemetry is added.

# Phase 04: OpenTelemetry instrumentation

## Objective

Emit complete traces, metrics, and logs from the demo and FlightRules services into SigNoz.

## Tasks

1. Initialise OTel before application imports that require auto-instrumentation.
2. Configure resource attributes.
3. Add HTTP instrumentation.
4. Add database instrumentation where applicable.
5. Add Pino log correlation.
6. Add explicit agent workflow, model, tool, and service spans.
7. Add standard GenAI attributes only after verifying released conventions.
8. Add custom safe attributes from Section 17.
9. Propagate trace context across all demo HTTP calls.
10. Add explicit side-effect and retry attributes.
11. Add idempotency key hash, never raw key.
12. Export traces, metrics, and logs through OTLP.
13. Add collector or SDK redaction rules.
14. Document telemetry schema.

## Tests and validation

- v1 appears as one complete distributed trace
- v2 appears as one complete distributed trace
- all services appear under expected names
- release ID and environment are queryable
- tool names and operations are queryable
- logs correlate to trace IDs
- token metrics appear when a live provider supplies usage
- scripted mode uses bounded deterministic token fixture values or leaves token fields absent, clearly labelled
- no raw prompts, tool arguments, tool results, secrets, or idempotency keys appear
- automated test inspects exported spans through an in-memory exporter
- integration test confirms telemetry in SigNoz through MCP search

## Exit gate

SigNoz can show complete v1 and v2 traces with enough safe structure for FlightRules to distinguish them.

# Phase 05: SigNoz MCP client and capability layer

## Objective

Create a typed, observable, testable FlightRules client for the official SigNoz MCP Server.

## Tasks

1. Use the official MCP TypeScript SDK.
2. Implement connection, authentication, timeout, and retry policy.
3. Add capability discovery.
4. Add typed wrappers for required tools.
5. Preserve structured MCP errors and validation notices.
6. Always include a useful `searchContext` where the server schema supports it.
7. Add read-before-write helpers.
8. Add read-back verification helpers.
9. Add deep-link preservation.
10. Add redacted request logging.
11. Add circuit-breaking or bounded retry behaviour.
12. Store capability snapshot in setup data.

## Tests and validation

- unit tests against an MCP fixture server
- malformed tool response rejected
- authentication failure classified correctly
- missing tool produces `MCP_TOOL_MISSING`
- timeout does not return a false success
- create-read-verify helper detects mismatched resource
- integration tests call the real local SigNoz MCP Server
- tool discovery snapshot stored in `docs/research/mcp-capabilities.json`

## Exit gate

FlightRules can query real traces and read and write a harmless test resource through MCP with verified read-back.

# Phase 06: Trace graph and normalisation engine

## Objective

Convert complete SigNoz traces into deterministic canonical graphs.

## Tasks

1. Define graph schema.
2. Parse MCP trace-detail responses using verified schemas.
3. Deduplicate spans.
4. Detect roots, orphans, cycles, and inconsistent duplicates.
5. Build parent and link edges.
6. Implement configurable normalisation.
7. Classify tools, side effects, retries, and data domains.
8. Canonically serialise graphs.
9. Generate SHA-256 fingerprints.
10. Generate weighted feature sets.
11. Implement graph diff.
12. Add safe graph JSON export.

## Tests and validation

- fixture traces from real local SigNoz are checked into safe test fixtures
- input-order permutation property test
- attribute-order permutation property test
- volatile-ID invariance property test
- meaningful-node-change fingerprint test
- edge-change fingerprint test
- duplicate-span test
- conflicting-duplicate test
- orphan-root test
- cycle detection test
- 1,000-span performance benchmark
- no stack overflow on deep traces

## Exit gate

The same logical v1 trace always produces the same fingerprint, and the unsafe v2 trace produces a structured diff.

# Phase 07: Contract schema and deterministic evaluator

## Objective

Implement the versioned contract DSL and run-level evaluator.

## Tasks

1. Create JSON Schema and TypeScript types.
2. Implement safe YAML parsing.
3. Implement static validation.
4. Implement every P0 rule type.
5. Implement evidence references.
6. Implement deterministic evaluation JSON.
7. Implement severity and zero-tolerance handling.
8. Add evaluator versioning.
9. Add contract content hash.
10. Add CLI validation command.

## Tests and validation

- valid sample contract passes
- every invalid schema case fails with exact path
- contradictory rules detected where possible
- every rule has passing and failing fixtures
- v1 passes the demo contract
- v2 fails critical rules
- evaluation is byte-stable after excluding completion time
- malicious YAML alias fixture rejected or bounded
- regex abuse fixture rejected
- property tests cover selector ordering and graph ordering

## Exit gate

The evaluator catches missing fraud, missing policy, and duplicate refund without using an LLM.

# Phase 08: Baseline mining and contract proposal

## Objective

Create a baseline from known-good SigNoz traces and propose a reviewable contract.

## Tasks

1. Implement trace selection job.
2. Fetch complete traces in bounded batches.
3. Exclude incomplete traces with reasons.
4. Group exact route fingerprints.
5. Calculate route statistics.
6. Select representative traces.
7. Mark rare families.
8. Implement approve and exclude actions.
9. Propose rules from approved families.
10. Attach evidence basis to every proposal.
11. Generate draft YAML.
12. Preserve baseline version and normaliser hash.

## Tests and validation

- insufficient run count blocks baseline
- duplicate trace IDs do not double-count
- incomplete traces are visible but excluded
- exact route grouping is correct
- route percentages sum correctly
- proposal includes required checks and side-effect cardinality
- no rule is activated automatically
- seeded v1 traces produce the expected draft contract

## Exit gate

A user can turn a set of v1 traces into an approved contract without hand-writing the initial policy.

# Phase 09: Application core, API, jobs, and persistence

## Objective

Expose stable product APIs and persist the full lifecycle.

## Tasks

1. Implement all P0 database tables and migrations.
2. Implement projects and agents.
3. Implement SigNoz connection setup.
4. Implement jobs with idempotency.
5. Implement baselines and route decisions.
6. Implement contract lifecycle.
7. Implement evaluations and violations.
8. Implement audit events.
9. Implement progress events.
10. Implement typed error envelope.
11. Add API documentation generated from source.
12. Add request IDs and tracing.

## Tests and validation

- migration from empty database
- rollback for latest migration in test environment
- CRUD permission boundary for local mode
- idempotent duplicate job request
- worker restart recovery
- no false pass after worker error
- API schema tests
- database integration tests
- audit records created for every lifecycle event

## Exit gate

All product state survives process restarts and can be driven without the UI.

# Phase 10: SigNoz artifact compiler

## Objective

Compile active contracts and FlightRules telemetry into native SigNoz operational artefacts.

## Tasks

1. Read SigNoz MCP resource instructions for views, dashboards, widgets, and alerts.
2. Implement deterministic managed resource names.
3. Compile supported rules into trace saved views.
4. Create the required dashboard.
5. Create required alerts.
6. Verify notification channel names.
7. Read every resource back.
8. Compare remote fields to desired fields.
9. Store resource IDs, web URLs, snapshots, and spec hashes.
10. Implement update without duplicate creation.
11. Implement drift detection.
12. Emit artifact-sync telemetry.

## Tests and validation

- first sync creates resources
- second identical sync creates none and updates none
- changed spec updates the same resource
- read-back mismatch fails the job
- dashboard panels return real data after demo runs
- violation alert fires after v2 evaluation
- alert history or active state proves firing
- recovery is observed where supported
- saved view opens matching violating traces
- deleted remote artifact is recreated or reported according to policy

## Exit gate

A contract activation produces working, verified SigNoz views, dashboard, and alerts rather than decorative copies inside FlightRules.

# Phase 11: Release evaluation, CLI, and GitHub gate

## Objective

Turn canary telemetry into a machine-enforceable release decision.

## Tasks

1. Implement release evaluation aggregation.
2. Implement minimum run and timeout logic.
3. Implement zero-tolerance rules.
4. Implement regression calculations.
5. Implement CLI commands:

```text
flightrules config verify
flightrules contract validate <path>
flightrules baseline capture
flightrules release evaluate
flightrules gate check
flightrules evidence export
```

6. Implement JSON output mode.
7. Implement documented exit codes.
8. Add GitHub Actions workflow.
9. Upload evidence artifact on failure.
10. Add PR summary or job summary.

## Tests and validation

- v1 gate exits 0
- v2 gate exits 2
- too few runs exits 3
- SigNoz unavailable exits 4
- invalid config exits 5
- CLI JSON matches schema
- no internal error returns pass
- GitHub workflow test repository or local action runner proves status behaviour

## Exit gate

A release pipeline can fail because of trajectory evidence from SigNoz.

# Phase 12: UI foundation and `design.md` integration

## Objective

Build the product shell, apply the supplied design system, and lock the information architecture.

## Entry criteria

- `design.md` exists
- design assets referenced by it are present
- product API is stable enough for UI work

## Tasks

1. Parse `design.md` and create `docs/adr/00XX-design-token-mapping.md`.
2. Create design tokens from the supplied values only.
3. Add asset loading and validation.
4. Build app shell, navigation, page headers, tables, cards, forms, dialogs, toasts, skeletons, and empty states.
5. Implement all routes from Section 8.
6. Add responsive layout.
7. Add accessible focus, keyboard, and screen-reader behaviour.
8. Add graph table fallback.
9. Add stable test selectors.
10. Add loading, empty, error, degraded, and success states.

## Design constraints

- no generic bento-grid dashboard unless `design.md` explicitly requires it
- no invented gradients, neon, glassmorphism, random blobs, or AI-template decoration
- no fake metrics
- no fake trace graphs in authenticated product routes
- landing visuals may use clearly labelled illustrative diagrams
- UI copy must come from this PRD or a later approved copy file

## Tests and validation

- route smoke tests
- accessibility scan
- keyboard navigation
- responsive screenshots
- missing asset fails build or produces an explicit development error
- no undefined colour or font token
- all displayed metrics trace to API data

## Exit gate

The full route shell matches `design.md`, keeps this PRD's content hierarchy, and has no placeholder copy.

# Phase 13: Baseline and Contract Studio UI

## Objective

Implement the complete baseline capture and contract review workflow.

## Tasks

1. Build baseline selection form.
2. Build job progress UI.
3. Build rejected-trace summary.
4. Build route-family list.
5. Build canonical route graph.
6. Build approve and exclude actions.
7. Build proposed-rule review.
8. Build YAML editor with schema errors.
9. Build graph-based rule controls.
10. Build contract validation, approval, activation, export, and SigNoz sync flows.
11. Prevent activation of invalid or unsaved changes.

## Tests and validation

- end-to-end baseline capture from seeded traces
- route approval persists
- exclusion records audit event
- invalid YAML cannot be approved
- graph rule edit changes YAML predictably
- YAML edit changes graph rule state predictably
- contract activation triggers artifact sync
- reload preserves state

## Exit gate

A new user can move from v1 traces to an active contract entirely through the UI.

# Phase 14: Release Diff UI

## Objective

Make behavioural release changes immediately understandable.

## Tasks

1. Build release list and status filters.
2. Build baseline-versus-canary graph diff.
3. Implement typed change list.
4. Show aggregate release metrics.
5. Show nearest approved route.
6. Show representative passing and failing traces.
7. Add SigNoz deep links.
8. Add evidence download.
9. Add re-evaluation action.
10. Add insufficient-data and error states.

## Tests and validation

- v1 release shows pass
- v2 release shows fail
- missing policy and fraud nodes are visually and textually identifiable
- duplicate payment node is identifiable
- graph has accessible text equivalent
- link opens the correct SigNoz trace
- no graph data is fabricated client-side

## Exit gate

A judge can understand the v2 regression from the release page without reading source code.

# Phase 15: Violation Inspector UI

## Objective

Provide complete trace-level evidence for each failed rule.

## Tasks

1. Build violation detail page.
2. Show rule definition and severity.
3. Highlight observed evidence nodes and edges.
4. Show approved comparison.
5. Show correlated logs fetched through MCP when requested.
6. Show downstream metrics.
7. Show release and contract context.
8. Show evaluation metadata.
9. Add copyable evidence summary.
10. Add safe SigNoz deep links.

## Tests and validation

- each demo critical violation has a page
- exact trace and span evidence displayed
- logs correlate by trace ID
- unsafe telemetry strings are escaped
- raw prompt fields remain absent
- failed log or metric fetch degrades without hiding the core violation

## Exit gate

Every release failure can be audited from rule to trace evidence to downstream effect.

# Phase 16: Hardening, performance, and adversarial validation

## Objective

Break the product before submission and fix every P0 weakness.

## Tasks

1. Run threat model review.
2. Run dependency and secret scans.
3. Fuzz contract parsing.
4. Fuzz graph parsing and selector evaluation.
5. Test large traces.
6. Test malformed MCP responses.
7. Test duplicate resource creation races.
8. Test worker restarts.
9. Test SigNoz temporary outage.
10. Test incomplete telemetry.
11. Test missing attributes.
12. Test malicious span names and HTML.
13. Test high-cardinality safeguards.
14. Measure performance targets.
15. Run accessibility audit.
16. Run full fresh-machine reproducibility test.

## Exit gate

No unresolved critical or high security issue, no failing P0 test, and no unverified installation step remains.

# Phase 17: Release, documentation, and submission

## Objective

Prepare a judge-reproducible repository and a precise presentation.

## Tasks

1. Finalise README.
2. Finalise architecture document.
3. Finalise threat model.
4. Finalise runbook.
5. Finalise demo script.
6. Finalise submission copy.
7. Add one-command or clearly sequenced setup.
8. Verify `casting.yaml` and lock file from a clean environment.
9. Verify all Docker images and packages are pinned.
10. Verify licence files and third-party notices.
11. Declare AI assistant use.
12. Create tagged release.
13. Record final test outputs.
14. Record final SigNoz resource links.
15. Produce a short fallback demo recording only after the live path works.

## Exit gate

A judge can clone, follow the README, run the demo, observe SigNoz, trigger v2, and see the release fail with real evidence.

---

# 22. Test strategy

## 22.1 Unit tests

Cover:

- normalisation functions
- graph construction
- fingerprinting
- selector matching
- every rule evaluator
- gate thresholds
- error mapping
- API validation
- telemetry redaction
- managed resource naming

## 22.2 Property-based tests

Required properties:

- graph fingerprint invariant to input ordering
- evaluation invariant to map ordering
- normalised IDs do not alter fingerprint
- meaningful node or edge change alters fingerprint
- duplicate identical spans do not alter result
- contradictory contract never evaluates as pass
- no internal error maps to pass

## 22.3 Integration tests

Cover:

- PostgreSQL
- real MCP fixture protocol
- local SigNoz MCP Server
- OTLP export
- trace search and trace details
- dashboard, view, and alert creation and read-back
- alert firing

## 22.4 End-to-end tests

Required scenarios:

1. setup connection
2. register demo agent
3. run v1 twenty times or configured minimum
4. capture baseline
5. approve route family
6. propose and approve contract
7. sync SigNoz artifacts
8. run v2
9. evaluate release
10. observe fail
11. open violation
12. open SigNoz trace
13. run CLI gate and receive exit code 2
14. reset demo

## 22.5 Reproducibility test

Run on a clean supported machine or clean VM:

```text
git clone
copy .env.example to .env and add required local secrets
install foundryctl
foundryctl cast -f casting.yaml
make install
make up
complete documented SigNoz API-key step
make verify
make demo
```

Record every manual step. Remove any unnecessary manual step.

## 22.6 Test naming

Tests must describe behaviour, not implementation.

Good:

```text
fails a release when a critical prerequisite is missing
keeps the same fingerprint when span input order changes
creates one managed dashboard on repeated sync
```

Bad:

```text
test evaluator
test graph
works
```

---

# 23. Acceptance matrix

`docs/ACCEPTANCE_MATRIX.md` must map every P0 requirement to:

```text
requirement ID
description
implementation path
test path
runtime evidence path
status
```

No P0 requirement may be marked complete without both a test and runtime evidence where runtime behaviour applies.

Critical final assertions:

```text
A1: Foundry reproduces SigNoz and MCP from casting files.
A2: v1 and v2 emit real distributed telemetry.
A3: v1 and v2 return materially the same customer answer.
A4: v1 includes policy and fraud checks.
A5: v2 omits those checks and duplicates payment.
A6: FlightRules reconstructs both trace graphs from SigNoz.
A7: The active contract passes v1.
A8: The active contract fails v2.
A9: The failure links to real SigNoz trace evidence.
A10: FlightRules creates and verifies a real SigNoz dashboard.
A11: FlightRules creates and verifies real SigNoz views.
A12: FlightRules creates an alert that fires from the v2 violation.
A13: The CLI gate returns exit code 2 for v2.
A14: No raw prompts or chain-of-thought are required.
A15: A clean clone can reproduce the system.
```

---

# 24. Demo and presentation script

## 24.1 Opening

```text
Most agent observability tools show whether an agent was slow, expensive, or wrong. Our failure is harder. The agent gives the right answer after taking the wrong path.
```

## 24.2 Show v1

1. Run the approved refund request.
2. Show the successful customer answer.
3. Open its SigNoz trace.
4. Point out policy, order, fraud, payment, and notification spans.
5. Capture or show the approved baseline.
6. Show the generated trajectory contract.

## 24.3 Show v2 without revealing the fault first

1. Run the same refund request against v2.
2. Show the same successful customer answer.
3. Ask whether the release looks safe from the output alone.
4. Run the FlightRules release evaluation.

## 24.4 Reveal

Show:

```text
FAIL
Missing policy.retrieve
Missing fraud.check
payment.refund called twice
Unknown route first observed in v2
```

Then open the graph diff and SigNoz trace.

## 24.5 Show SigNoz depth

1. Open the managed Contract Health dashboard.
2. Show the violation-rate panel.
3. Show duplicate side-effects panel.
4. Show the firing alert.
5. Open the violating saved view.
6. Show correlated payment logs.

## 24.6 Show release gate

Run:

```text
flightrules gate check --agent refund-agent --release refund-agent-v2 --contract contracts/demo-commerce/refund-agent/production/contract.yaml
```

Show non-zero exit and evidence summary.

## 24.7 Close

```text
SigNoz already records the full journey. FlightRules turns that journey into a release contract.
```

---

# 25. README requirements

The README must include:

1. one-sentence product definition
2. problem and demo failure
3. architecture diagram
4. SigNoz feature usage
5. exact prerequisites
6. Foundry installation
7. API-key setup
8. application startup
9. demo commands
10. test commands
11. contract example
12. CLI gate example
13. privacy model
14. known limitations
15. repository structure
16. AI assistant disclosure
17. licences

Do not lead with a long feature list. Lead with the unsafe route that output evaluation misses.

---

# 26. Required documentation files

```text
docs/PRD.md
docs/ARCHITECTURE.md
docs/THREAT_MODEL.md
docs/RUNBOOK.md
docs/DEMO_SCRIPT.md
docs/SUBMISSION.md
docs/ACCEPTANCE_MATRIX.md
docs/research/source-lock.md
docs/research/compatibility-matrix.md
docs/research/mcp-capabilities.json
docs/research/otel-attributes.md
docs/adr/*.md
docs/evidence/phase-*.md
```

Architecture documentation must state what is observed, inferred, and unavailable in a trace.

---

# 27. Submission positioning

Product title:

```text
FlightRules: Executable Trajectory Contracts for AI Agents
```

One-line description:

```text
FlightRules turns SigNoz traces into deterministic release contracts that catch skipped checks, duplicate side effects, unknown tool paths, and behavioural drift before an agent canary reaches production.
```

Track:

```text
AI & Agent Observability
```

Why SigNoz is load-bearing:

- SigNoz stores the distributed trace evidence used to reconstruct routes.
- Query Builder and Trace Matching provide native investigation paths.
- MCP is the programmatic control surface for trace queries, dashboards, saved views, and alerts.
- FlightRules emits evaluation telemetry back into SigNoz.
- The demo's release decision links to SigNoz traces, logs, metrics, dashboards, and alerts.
- Removing SigNoz breaks baseline capture, evidence retrieval, artifact compilation, alerting, and the final proof.

Do not describe SigNoz as a passive data source. It is the operational substrate of the product.

---

# 28. Known technical risks and required responses

## Risk: incomplete or sampled traces

Response:

- label trace quality
- exclude incomplete traces from baseline by default
- never infer absent critical steps from a known incomplete trace
- allow contract evaluation to return error or insufficient evidence

## Risk: asynchronous steps do not share one trace

Response:

- P0 supports one primary trace
- span links and explicit predecessor attributes are supported
- cross-trace workflow correlation is P2
- document the boundary honestly

## Risk: timestamps imply false causality

Response:

- timestamps are display order only by default
- critical rules require parent, link, or explicit predecessor evidence

## Risk: high-cardinality route explosion

Response:

- versioned normalisation
- bounded route families
- rare-path threshold
- cardinality monitoring
- no dynamic IDs in metric labels

## Risk: MCP schema changes

Response:

- capability discovery
- typed runtime validation
- compatibility page
- pinned MCP version
- read-back verification

## Risk: SigNoz dashboard schema changes

Response:

- read current MCP resource instructions
- create through supported tools
- store remote snapshots and spec hashes
- fail sync on mismatch

## Risk: agent output differs nondeterministically

Response:

- scripted provider is canonical automated demo
- real provider mode is optional
- trajectory faults are injected at orchestrator and service layers for repeatability

## Risk: duplicate payment appears artificial

Response:

- implement a real timeout and retry path
- show payment-service idempotency ledger and correlated logs
- include an unsafe mode with missing or changed idempotency key

## Risk: product becomes a dashboard wrapper

Response:

- keep contract mining, graph reconstruction, deterministic evaluation, and release gating as the core
- SigNoz dashboard is generated operational output, not the product itself

---

# 29. Stop conditions

Claude must stop the active phase and report `BLOCKED` when:

- an official required capability does not exist
- a required MCP tool is absent in the pinned version
- a documented installation cannot be reproduced
- a security control cannot be implemented safely
- a P0 test reveals the product claim is false
- a trace lacks enough causal evidence for the proposed rule
- `design.md` is missing when Phase 12 begins
- a dependency licence is incompatible
- a required resource can be created but cannot be verified

Claude must propose a grounded alternative that preserves the product thesis. It must not silently fake the missing capability.

---

# 30. Initial official source register

Claude must reverify these sources and pin the exact accessed versions in `docs/research/source-lock.md`.

## SigNoz and Foundry

- SigNoz Docker installation through Foundry: https://signoz.io/docs/install/docker/
- Foundry repository: https://github.com/SigNoz/foundry
- Foundry getting started: https://github.com/SigNoz/foundry/blob/main/docs/getting-started.md
- Foundry casting reference: https://github.com/SigNoz/foundry/blob/main/docs/reference/casting-file.md
- SigNoz releases: https://github.com/SigNoz/signoz/releases

## SigNoz querying and trace analysis

- Query Builder v5: https://signoz.io/docs/userguide/query-builder-v5/
- Querying traces: https://signoz.io/docs/apm-and-distributed-tracing/querying-traces/
- Trace Explorer: https://signoz.io/docs/userguide/traces/
- Multi-query and Trace Matching: https://signoz.io/docs/querying/multi-query-analysis/
- Trace details: https://signoz.io/docs/userguide/span-details/
- Trace-based alerts: https://signoz.io/docs/alerts-management/trace-based-alerts/
- Dashboards: https://signoz.io/docs/userguide/manage-dashboards/

## SigNoz MCP

- MCP documentation: https://signoz.io/docs/ai/signoz-mcp-server/
- MCP repository: https://github.com/SigNoz/signoz-mcp-server
- MCP README and tool list: https://github.com/SigNoz/signoz-mcp-server/blob/main/README.md

## OpenTelemetry

- Semantic conventions: https://opentelemetry.io/docs/specs/semconv/
- GenAI attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
- GenAI semantic conventions repository: https://github.com/open-telemetry/semantic-conventions-genai
- OpenTelemetry JavaScript: https://github.com/open-telemetry/opentelemetry-js
- OpenTelemetry JavaScript contrib: https://github.com/open-telemetry/opentelemetry-js-contrib

Proposals and open issues may inform future design but must not be treated as released conventions.

---

# 31. First instruction to give Claude Code

Use the following when starting the repository build:

```text
Read docs/PRD.md in full before changing any file. You are building FlightRules under the phase-gated operating contract in that document.

Begin with Phase 00 only. Do not scaffold the application yet. Verify the current official SigNoz, Foundry, SigNoz MCP Server, OpenTelemetry JavaScript, GenAI semantic conventions, Node.js, package-manager, and MCP SDK surfaces. Create the required source-lock, compatibility matrix, ADR, CLAUDE.md, phase plan, and phase result files. Run the required feasibility checks. Report PASS, BLOCKED, or FAIL using the mandated phase report format.

Do not begin Phase 01 unless Phase 00 passes. Do not invent APIs, fields, versions, commands, or schemas. Use official sources and installed runtime evidence. No co-author trailers.
```

---

# 32. Definition of done

FlightRules is done for the hackathon only when a fresh deployment proves this complete chain:

```text
Foundry deploys SigNoz and MCP
-> refund-agent-v1 emits known-good telemetry
-> FlightRules retrieves complete traces through MCP
-> FlightRules reconstructs and approves the v1 route
-> FlightRules proposes and activates a trajectory contract
-> FlightRules creates and verifies SigNoz views, dashboard, and alerts
-> refund-agent-v2 returns the same customer answer through an unsafe route
-> FlightRules retrieves and evaluates the v2 traces
-> FlightRules detects skipped checks and duplicate payment
-> SigNoz alert fires
-> Release Diff and Violation Inspector show real evidence
-> CLI or GitHub gate exits non-zero
-> README instructions reproduce the result
```

Anything less is an incomplete vertical slice.
