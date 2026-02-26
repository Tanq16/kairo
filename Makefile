.PHONY: help assets verify-assets codemirror clean build build-for build-all docker-build docker-push version

# =============================================================================
# Variables
# =============================================================================
APP_NAME := kairo
DOCKER_USER := tanq16

# Build variables (set by CI or use defaults)
VERSION ?= dev-build
GOOS ?= $(shell go env GOOS)
GOARCH ?= $(shell go env GOARCH)

# Directories
STATIC_DIR := internal/server/static
JS_DIR := $(STATIC_DIR)/js
CSS_DIR := $(STATIC_DIR)/css
FONTS_DIR := $(STATIC_DIR)/fonts

# Asset versions
LUCIDE_VERSION := 0.575.0
MARKEDJS_VERSION := 17.0.3
HIGHLIGHTJS_VERSION := 11.11.1
MERMAIDJS_VERSION := 11.12.3
CODEMIRROR_BUNDLE := $(JS_DIR)/codemirror-bundle.min.js

# Console colors
CYAN := \033[0;36m
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m

# =============================================================================
# Help
# =============================================================================
help: ## Show this help
	@echo "$(CYAN)Available targets:$(NC)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'

.DEFAULT_GOAL := help

# =============================================================================
# Assets
# =============================================================================
assets: ## Download static assets
	@echo "$(CYAN)Downloading assets...$(NC)"
	@mkdir -p $(JS_DIR) $(CSS_DIR) $(FONTS_DIR) $(STATIC_DIR)/icons
	@curl -sL "https://cdn.tailwindcss.com" -o "$(JS_DIR)/tailwindcss.js"
	@curl -sL "https://unpkg.com/lucide@$(LUCIDE_VERSION)/dist/umd/lucide.min.js" -o "$(JS_DIR)/lucide.min.js"
	@curl -sL "https://cdn.jsdelivr.net/npm/marked@$(MARKEDJS_VERSION)/lib/marked.umd.js" -o "$(JS_DIR)/marked.min.js"
	@curl -sL "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/$(HIGHLIGHTJS_VERSION)/highlight.min.js" -o "$(JS_DIR)/highlight.min.js"
	@curl -sL "https://cdn.jsdelivr.net/npm/mermaid@$(MERMAIDJS_VERSION)/dist/mermaid.min.js" -o "$(JS_DIR)/mermaid.min.js"
	@curl -sL "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/$(HIGHLIGHTJS_VERSION)/styles/github-dark.min.css" -o "$(CSS_DIR)/github-dark.min.css"
	@curl -sL "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" -H "User-Agent: Mozilla/5.0" -o "$(CSS_DIR)/inter.css"
	@grep -o "https://fonts.gstatic.com/[^)']*" "$(CSS_DIR)/inter.css" | sort -u | while read url; do \
		filename=$$(basename "$$url" | sed 's/?.*//'); \
		curl -sL "$$url" -o "$(FONTS_DIR)/$$filename"; \
	done
	@sed -i.bak -E 's|https://fonts.gstatic.com/s/inter/[^/]+/||g' "$(CSS_DIR)/inter.css" && rm -f "$(CSS_DIR)/inter.css.bak"
	@sed -i.bak 's|src: url(|src: url(/static/fonts/|g' "$(CSS_DIR)/inter.css" && rm -f "$(CSS_DIR)/inter.css.bak"
	@curl -sL "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" -H "User-Agent: Mozilla/5.0" -o "$(CSS_DIR)/jetbrains-mono.css"
	@grep -o "https://fonts.gstatic.com/[^)']*" "$(CSS_DIR)/jetbrains-mono.css" | sort -u | while read url; do \
		filename=$$(basename "$$url" | sed 's/?.*//'); \
		curl -sL "$$url" -o "$(FONTS_DIR)/$$filename"; \
	done
	@sed -i.bak -E 's|https://fonts.gstatic.com/s/jetbrainsmono/[^/]+/||g' "$(CSS_DIR)/jetbrains-mono.css" && rm -f "$(CSS_DIR)/jetbrains-mono.css.bak"
	@sed -i.bak 's|src: url(|src: url(/static/fonts/|g' "$(CSS_DIR)/jetbrains-mono.css" && rm -f "$(CSS_DIR)/jetbrains-mono.css.bak"
	@cp .github/assets/logo.svg $(STATIC_DIR)/icons/favicon.svg
	@echo "$(GREEN)Assets downloaded$(NC)"

verify-assets: ## Verify required assets exist
	@test -f $(JS_DIR)/tailwindcss.js || (echo "$(YELLOW)tailwindcss.js missing. Run 'make assets'$(NC)" && exit 1)
	@test -f $(CODEMIRROR_BUNDLE) || (echo "$(YELLOW)codemirror-bundle.min.js missing. Run 'make codemirror'$(NC)" && exit 1)
	@echo "$(GREEN)Assets verified$(NC)"

codemirror: ## Rebuild CodeMirror 6 bundle (requires Node.js)
	@echo "$(CYAN)Building CodeMirror bundle...$(NC)"
	@test -d node_modules/@codemirror || npm install --silent --no-audit --no-fund \
		@codemirror/view @codemirror/state @codemirror/lang-markdown \
		@codemirror/commands @codemirror/autocomplete @codemirror/language @lezer/highlight
	@npx esbuild cm-entry.js --bundle --format=iife --global-name=CM --minify --outfile=$(CURDIR)/$(CODEMIRROR_BUNDLE)
	@echo "$(GREEN)CodeMirror bundle built$(NC)"

clean: ## Remove built artifacts and downloaded assets
	@rm -f $(APP_NAME) $(APP_NAME)-*
	@rm -rf $(JS_DIR)/*.min.js $(JS_DIR)/tailwindcss.js $(CSS_DIR)/*.css $(FONTS_DIR)/*.ttf $(STATIC_DIR)/icons/favicon.svg
	@rm -rf node_modules package.json package-lock.json
	@echo "$(GREEN)Cleaned$(NC)"

# =============================================================================
# Build
# =============================================================================
build: verify-assets ## Build binary for current platform
	@go build -ldflags="-s -w -X 'github.com/tanq16/kairo/cmd.AppVersion=$(VERSION)'" -o $(APP_NAME) .
	@echo "$(GREEN)Built: ./$(APP_NAME)$(NC)"

build-for: verify-assets ## Build binary for specified GOOS/GOARCH
	@CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -ldflags="-s -w -X 'github.com/tanq16/kairo/cmd.AppVersion=$(VERSION)'" -o $(APP_NAME)-$(GOOS)-$(GOARCH) .
	@echo "$(GREEN)Built: ./$(APP_NAME)-$(GOOS)-$(GOARCH)$(NC)"

build-all: verify-assets ## Build all platform binaries
	@$(MAKE) build-for GOOS=linux GOARCH=amd64
	@$(MAKE) build-for GOOS=linux GOARCH=arm64
	@$(MAKE) build-for GOOS=darwin GOARCH=amd64
	@$(MAKE) build-for GOOS=darwin GOARCH=arm64

# =============================================================================
# Docker
# =============================================================================
docker-build: ## Build Docker image
	@docker build --build-arg VERSION=$(VERSION) -t $(DOCKER_USER)/$(APP_NAME):$(VERSION) .
	@docker tag $(DOCKER_USER)/$(APP_NAME):$(VERSION) $(DOCKER_USER)/$(APP_NAME):latest
	@echo "$(GREEN)Docker image built$(NC)"

docker-push: docker-build ## Push Docker image to Docker Hub
	@docker push $(DOCKER_USER)/$(APP_NAME):$(VERSION)
	@docker push $(DOCKER_USER)/$(APP_NAME):latest
	@echo "$(GREEN)Docker image pushed$(NC)"

# =============================================================================
# Version
# =============================================================================
version: ## Calculate next version from commit message
	@LATEST_TAG=$$(git tag --sort=-v:refname | head -n1 || echo "0.0.0"); \
	LATEST_TAG=$${LATEST_TAG#v}; \
	MAJOR=$$(echo "$$LATEST_TAG" | cut -d. -f1); \
	MINOR=$$(echo "$$LATEST_TAG" | cut -d. -f2); \
	PATCH=$$(echo "$$LATEST_TAG" | cut -d. -f3); \
	MAJOR=$${MAJOR:-0}; MINOR=$${MINOR:-0}; PATCH=$${PATCH:-0}; \
	COMMIT_MSG="$$(git log -1 --pretty=%B)"; \
	if echo "$$COMMIT_MSG" | grep -q "\[major-release\]"; then \
		MAJOR=$$((MAJOR + 1)); MINOR=0; PATCH=0; \
	elif echo "$$COMMIT_MSG" | grep -q "\[minor-release\]"; then \
		MINOR=$$((MINOR + 1)); PATCH=0; \
	else \
		PATCH=$$((PATCH + 1)); \
	fi; \
	echo "v$${MAJOR}.$${MINOR}.$${PATCH}"
