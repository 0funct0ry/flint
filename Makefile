# Makefile for Flint

# Variables
CARGO = cargo
PNPM = pnpm
TAURI = $(PNPM) tauri

# Default target
.DEFAULT_GOAL := help

.PHONY: all help clean build build-release clippy test test-backend test-frontend fmt \
	ci ci-fmt-check ci-clippy ci-rust-test ci-rust-build ci-lint ci-typecheck ci-frontend-test ci-frontend-build ci-tauri-build

all: build

# Target-specific help messages
help: ## Display this help message
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

clean: ## Remove build artifacts
	@echo "Cleaning Cargo artifacts..."
	@$(CARGO) clean
	@echo "Cleaning frontend artifacts..."
	@rm -rf dist
	@rm -rf src-tauri/target

build: ## Build the project in debug mode
	@echo "Building frontend..."
	@$(PNPM) build
	@echo "Building backend..."
	@$(CARGO) build --workspace

build-release: ## Build the project in release mode
	@echo "Building production release..."
	@$(CARGO) build --release

clippy: ## Run clippy lints
	@echo "Running Clippy..."
	@$(CARGO) clippy --workspace --all-targets -- -D warnings

test: ## Run all tests (Rust and Frontend)
	@$(MAKE) test-backend
	@$(MAKE) test-frontend

test-backend: ## Run Rust tests
	@echo "Running Rust tests..."
	@$(CARGO) test --workspace

test-frontend: ## Run frontend tests
	@echo "Running frontend tests..."
	@$(PNPM) test

fmt: ## Format Rust and Frontend code
	@echo "Formatting Rust code..."
	@$(CARGO) fmt --all
	@echo "Formatting Frontend code..."
	@$(PNPM) lint --fix

# ---------------------------------------------------------------------------
# CI parity targets — each one runs the exact command used in the matching
# .github/workflows/ci.yml step, so a green `make ci` here means CI won't fail.
# ---------------------------------------------------------------------------

ci: ci-fmt-check ci-clippy ci-rust-test ci-lint ci-typecheck ci-frontend-test ci-frontend-build ## Run every check the GitHub Actions CI workflow runs (excludes the native app bundle build; see ci-tauri-build)
	@echo ""
	@echo "✅ All CI checks passed."

ci-fmt-check: ## [rust job] cargo fmt --check
	@echo "==> cargo fmt --check"
	@$(CARGO) fmt --check

ci-clippy: ## [rust job] cargo clippy --workspace --locked -- -D warnings
	@echo "==> cargo clippy --workspace --locked -- -D warnings"
	@$(CARGO) clippy --workspace --locked -- -D warnings

ci-rust-test: ## [rust job] cargo test --workspace --locked
	@echo "==> cargo test --workspace --locked"
	@$(CARGO) test --workspace --locked

ci-lint: ## [frontend job] pnpm lint
	@echo "==> pnpm lint"
	@$(PNPM) lint

ci-typecheck: ## [frontend job] pnpm typecheck
	@echo "==> pnpm typecheck"
	@$(PNPM) typecheck

ci-frontend-test: ## [frontend job] pnpm test
	@echo "==> pnpm test"
	@$(PNPM) test

ci-frontend-build: ## [frontend job] pnpm build
	@echo "==> pnpm build"
	@$(PNPM) build

ci-tauri-build: ## [rust job] pnpm exec tauri build --bundles app (slow, produces a full Flint.app bundle; not part of `make ci` by default)
	@echo "==> pnpm exec tauri build --bundles app"
	@$(PNPM) exec tauri build --bundles app
