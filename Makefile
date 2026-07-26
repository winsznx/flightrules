SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help
.PHONY: help verify-env install lint lint-fix format format-check typecheck test test-integration \
        test-integration-db test-integration-signoz test-e2e build up down db-migrate db-rollback db-status scan-secrets scan-licences \
        scan-deps verify clean contract-validate demo-up demo-v1 demo-v2 demo-reset signoz-gauge signoz-forge signoz-up signoz-down signoz-destroy \
        signoz-bootstrap signoz-verify signoz-capabilities signoz-reproducibility mine-demo-baseline \
        signoz-sync signoz-purge api worker web cli demo-seed demo-full demo-urls gate gate-json evidence scan-design

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

verify-env: ## Verify the local toolchain matches the pinned versions
	@bash scripts/verify-environment.sh

install: ## Install dependencies from the committed lockfile
	pnpm install --frozen-lockfile

lint: ## Lint and check formatting
	pnpm run lint

lint-fix: ## Apply safe lint and formatting fixes
	pnpm run lint:fix

format: ## Format the repository
	pnpm run format

format-check: ## Check formatting without writing
	pnpm run format:check

typecheck: ## Strict TypeScript build of every package
	pnpm run typecheck

test: ## Run unit and property tests (no external services required)
	pnpm run test

test-integration: ## Run all integration tests (requires make up and a running SigNoz stack)
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm run test:integration

test-integration-db: ## Run database integration tests (requires make up)
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm run test:integration:db

test-integration-signoz: ## Run SigNoz integration tests (requires a deployed, bootstrapped stack)
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm run test:integration:signoz

test-e2e: ## Run end-to-end browser tests against the running product
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm run test:e2e

build: ## Build every package and application
	pnpm run build

up: ## Start FlightRules application services and wait for health
	docker compose -f compose.app.yaml up -d --wait

demo-up: ## Build and start the demo topology and wait for health
	docker compose -f compose.app.yaml up -d --build --wait

demo-v1: ## Run the approved refund-agent-v1 release
	@bash scripts/run-demo-v1.sh

demo-v2: ## Run the unsafe refund-agent-v2 release
	@bash scripts/run-demo-v2.sh

demo-reset: ## Reset demo state without touching the SigNoz installation
	@bash scripts/reset-demo.sh

mine-demo-baseline: ## Mine a baseline from live v1 telemetry and write the proposed contract
	@set -a; [ -f .env ] && . ./.env; set +a; node scripts/mine-demo-baseline.mjs

down: ## Stop FlightRules application services
	docker compose -f compose.app.yaml down

api: ## Run the FlightRules API (requires make up and make db-migrate)
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm --filter @flightrules/api run dev

worker: ## Run the FlightRules job worker (requires make up and make db-migrate)
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm --filter @flightrules/worker run dev

cli: ## Run the FlightRules CLI. Pass arguments with ARGS="gate check --json"
	@set -a; [ -f .env ] && . ./.env; set +a; \
		node apps/cli/dist/index.js $(ARGS)

demo-seed: ## Seed project, agent, baseline, contract and SigNoz artefacts through the API
	@bash scripts/seed-demo.sh $(ARGS)

demo-full: ## The complete demo: telemetry, baseline, contract, artefacts, passing gate, failing gate
	@bash scripts/demo-full.sh

demo-urls: ## Resolve every demo URL from the running API and write .demo-state.json
	@set -a; [ -f .env ] && . ./.env; set +a; node scripts/demo-urls.mjs

gate: ## Read the release gate and exit with its code (PROJECT, AGENT, RELEASE)
	@set -a; [ -f .env ] && . ./.env; set +a; \
		node apps/cli/dist/index.js gate check \
			--project "$${PROJECT:-demo-commerce}" \
			--agent "$${AGENT:-refund-agent}" \
			--release "$${RELEASE:-refund-agent-v1}"

gate-json: ## The same decision as one machine-readable document
	@set -a; [ -f .env ] && . ./.env; set +a; \
		node apps/cli/dist/index.js gate check --json --quiet \
			--project "$${PROJECT:-demo-commerce}" \
			--agent "$${AGENT:-refund-agent}" \
			--release "$${RELEASE:-refund-agent-v1}"

evidence: ## Export the release evidence bundle to OUT (default docs/evidence/release-gate.json)
	@set -a; [ -f .env ] && . ./.env; set +a; \
		node apps/cli/dist/index.js evidence export --include-violations \
			--project "$${PROJECT:-demo-commerce}" \
			--agent "$${AGENT:-refund-agent}" \
			--release "$${RELEASE:-refund-agent-v1}" \
			--out "$${OUT:-docs/evidence/release-gate.json}"

# These three load .env the same way `api`, `worker` and `test-integration` do. Without it
# `make db-migrate` — a documented README step — fails with "DATABASE_URL is not set." on any
# machine that has not exported the variable by hand, which is every fresh machine.
db-migrate: ## Apply database migrations
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm --filter @flightrules/db run migrate

db-rollback: ## Revert the most recent database migration
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm --filter @flightrules/db run rollback

db-status: ## Show applied database migrations
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm --filter @flightrules/db run migrate:status

contract-validate: ## Validate every committed contract document
	@bash scripts/validate-contracts.sh

scan-secrets: ## Scan the repository for committed secrets
	pnpm run scan:secrets

scan-licences: ## Check every installed dependency licence
	pnpm run scan:licences

scan-deps: ## Audit dependencies for known vulnerabilities
	pnpm run scan:deps

signoz-gauge: ## Check the tools Foundry needs are available
	foundryctl gauge -f casting.yaml --format text --no-ledger --no-updater

signoz-forge: ## Regenerate casting.yaml.lock and pours/
	foundryctl forge -f casting.yaml --format text --no-ledger --no-updater

signoz-up: ## Deploy the pinned SigNoz stack
	foundryctl cast -f casting.yaml --format text --no-ledger --no-updater

signoz-down: ## Stop the SigNoz stack, keeping all telemetry
	docker compose -f pours/deployment/compose.yaml -p signoz stop

signoz-destroy: ## Stop the SigNoz stack and delete all telemetry volumes
	docker compose -f pours/deployment/compose.yaml -p signoz down -v

signoz-bootstrap: ## Create the first SigNoz user and mint a FlightRules API key
	@bash scripts/bootstrap-signoz.sh

signoz-verify: ## Verify every SigNoz surface against the running deployment
	@bash scripts/verify-signoz.sh

signoz-capabilities: ## Refresh docs/research/mcp-capabilities.json from the live MCP server
	@set -a; [ -f .env ] && . ./.env; set +a; node scripts/snapshot-mcp-capabilities.mjs

signoz-reproducibility: ## Prove the casting reproduces and every image is pinned
	@bash scripts/verify-reproducibility.sh

signoz-sync: ## Compile the active contract of every agent in PROJECT into SigNoz artefacts
	@bash scripts/sync-signoz-artifacts.sh

signoz-purge: ## Delete the managed SigNoz artefacts of PROJECT (default demo-commerce)
	@set -a; [ -f .env ] && . ./.env; set +a; \
		node scripts/purge-managed-artifacts.mjs "$${PROJECT:-demo-commerce}"

verify: ## Complete validation suite
	@$(MAKE) verify-env
	@$(MAKE) format-check
	@$(MAKE) lint
	@$(MAKE) typecheck
	@$(MAKE) test
	@$(MAKE) build
	@$(MAKE) contract-validate
	@$(MAKE) scan-design
	@$(MAKE) scan-secrets
	@$(MAKE) scan-licences

clean: ## Remove build output
	find . -type d -name dist -not -path './node_modules/*' -prune -exec rm -rf {} +
	rm -rf .vitest

web: ## Run the FlightRules web application (requires make api)
	@set -a; [ -f .env ] && . ./.env; set +a; pnpm --filter @flightrules/web run dev

scan-design: ## Check design tokens and assets against design.md
	@node scripts/check-design-assets.mjs
