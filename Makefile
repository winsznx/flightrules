SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help
.PHONY: help verify-env install lint lint-fix format format-check typecheck test test-integration \
        test-integration-db test-integration-signoz test-e2e build up down db-migrate db-rollback db-status scan-secrets scan-licences \
        scan-deps verify clean demo-up demo-v1 demo-v2 demo-reset signoz-gauge signoz-forge signoz-up signoz-down signoz-destroy \
        signoz-bootstrap signoz-verify signoz-capabilities signoz-reproducibility

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
	pnpm run test:integration

test-integration-db: ## Run database integration tests (requires make up)
	pnpm run test:integration:db

test-integration-signoz: ## Run SigNoz integration tests (requires a deployed, bootstrapped stack)
	pnpm run test:integration:signoz

test-e2e: ## Run end-to-end browser tests
	pnpm run test:e2e

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

down: ## Stop FlightRules application services
	docker compose -f compose.app.yaml down

db-migrate: ## Apply database migrations
	pnpm --filter @flightrules/db run migrate

db-rollback: ## Revert the most recent database migration
	pnpm --filter @flightrules/db run rollback

db-status: ## Show applied database migrations
	pnpm --filter @flightrules/db run migrate:status

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

verify: ## Complete validation suite
	@$(MAKE) verify-env
	@$(MAKE) format-check
	@$(MAKE) lint
	@$(MAKE) typecheck
	@$(MAKE) test
	@$(MAKE) build
	@$(MAKE) scan-secrets
	@$(MAKE) scan-licences

clean: ## Remove build output
	find . -type d -name dist -not -path './node_modules/*' -prune -exec rm -rf {} +
	rm -rf .vitest
