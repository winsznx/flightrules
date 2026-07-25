# Phase 00 plan — Source lock and feasibility proof

Branch: `phase/00-source-lock`
Started: 2026-07-25

## Objective (PRD section 21, Phase 00)

Prove the current official SigNoz, Foundry, SigNoz MCP Server, OpenTelemetry JavaScript,
GenAI semantic convention, Node.js, package-manager and MCP SDK surfaces before any
application code is written.

## Entry criteria check

| Criterion | Status | Note |
|---|---|---|
| Empty or newly created repository | Satisfied | Repository contained only `design.md` and `docs/FLIGHTRULES_END_TO_END_PRD.md`; no Git history existed, so `git init` was run as the first action. |
| PRD available as `docs/PRD.md` | Satisfied after copy | The authoritative document was supplied as `docs/FLIGHTRULES_END_TO_END_PRD.md`. PRD section 13 permits `docs/PRD.md` to be that file copied verbatim, so it was copied byte for byte. Both files hash to `8f025676c470c65aa4e5259622cb8eb7a91d8815079160e6754b6942dea15de9`. |
| Design specification present | Satisfied | Supplied at repository root as `design.md` (PRD section 13 places `design.md` at the root). SHA-256 `b3c20d6318fa03d186387d6d7c7cf4c8855bf6fb8c25e5161b08cb598c84c43d`. |
| Internet access for official documentation and repositories | Satisfied | `signoz.io` and `api.github.com` both returned HTTP 200. |

## Planned tasks

1. Record the local environment (OS, arch, Node, pnpm, Docker, Git).
2. Verify the latest stable SigNoz release and the compatible Foundry default.
3. Install `foundryctl` from the official script and record its version and commit.
4. Generate the official Foundry examples locally and read the installed casting schema
   rather than trusting the PRD's illustrative snippet.
5. Verify how `casting.yaml.lock` is generated and whether it is stable across repeated forges.
6. Deploy the pinned stack once, purely to obtain runtime evidence, and verify SigNoz health,
   OTLP gRPC and HTTP ports, and the MCP `/livez` and `/readyz` probes.
7. Complete the SigNoz first-user and API-key flow against the running instance, using the
   installed OpenAPI schema as the source of truth for request shapes.
8. Connect the official MCP TypeScript SDK to the running SigNoz MCP Server, capture the
   complete tool surface **including input schemas**, and store it as the capability snapshot.
9. Verify the released OpenTelemetry GenAI semantic conventions and their stability from the
   installed package, not from memory.
10. Verify Node.js, pnpm, TypeScript, Next.js and React compatibility by running a real strict
    typecheck.
11. Run the feasibility proofs required by the user's execution contract for every link of the
    central product chain.
12. Write `CLAUDE.md`, the source lock, the compatibility matrix, the attribute register, the
    MCP capability snapshot, the ADRs, the initial acceptance matrix, and the phase result.

## Feasibility proofs planned

| Chain link | Planned proof |
|---|---|
| OpenTelemetry emits the required trace structure | Emit a real parent/child trace with custom attributes from Node using the pinned OTel JS packages; assert structure through an in-memory exporter. |
| SigNoz ingests it | Export the same spans over OTLP/HTTP to the Foundry-deployed collector. |
| FlightRules can retrieve complete trace evidence | Fetch the same trace back through the SigNoz MCP Server and confirm span identity, parent linkage and **custom attributes** are all retrievable. |
| FlightRules can reconstruct trajectories | Confirm `span_id`, `parent_span_id`, `name`, `kind`, `duration_nano` and service are all present in the retrieved rows. |
| Deterministic contracts can be evaluated | Confirmed by construction: evaluation is pure local computation over the retrieved graph; no external capability is required. Property tests land in Phase 06 and 07. |
| Result telemetry can be written back to SigNoz | Same OTLP path as the emission proof. |
| Required SigNoz operational artefacts can be created and read back | Create a saved view through MCP, read it back by ID, list it, compare fields, then delete it. |
| A CLI or CI release gate can return a deterministic non-zero exit code | Node process exit codes; no external capability required. Implemented in Phase 11. |

## Explicit non-goals for this phase

- No application scaffolding, no workspace, no product source files.
- No committed `casting.yaml`. The Phase 00 deployment is a throwaway verification performed in
  the scratch directory; the committed, reproducible casting is Phase 02 work.
