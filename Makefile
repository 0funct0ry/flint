# Makefile for Flint

# Variables
CARGO = cargo
PNPM = pnpm
TAURI = $(PNPM) tauri

# Default target
.DEFAULT_GOAL := help

.PHONY: all help clean build build-release clippy test test-backend test-frontend fmt

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
