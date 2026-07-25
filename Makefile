SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help
.PHONY: help verify-env install lint lint-fix format format-check typecheck test test-integration \
        test-e2e build up down db-migrate db-rollback db-status scan-secrets scan-licences \
        scan-deps verify clean

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

test-integration: ## Run integration tests (requires make up and a running SigNoz stack)
	pnpm run test:integration

test-e2e: ## Run end-to-end browser tests
	pnpm run test:e2e

build: ## Build every package and application
	pnpm run build

up: ## Start FlightRules application services and wait for health
	docker compose -f compose.app.yaml up -d --wait

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
