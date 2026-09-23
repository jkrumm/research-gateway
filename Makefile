# ==============================================================================
# Mini LaunchAgents — a native second instance of research-gateway (:7780) plus
# the lightpanda sidecar (:7781), running as launchd LaunchAgents from a
# DEDICATED deploy clone at ~/.research-gateway/app (never this dev checkout —
# see scripts/mini-deploy.sh, scripts/launch.sh). The VPS keeps its own Docker
# instance via rollhook; this Makefile only manages the mini's copy.
# ==============================================================================

APP_DIR       := $(HOME)/.research-gateway/app
DATA_DIR      := $(HOME)/.research-gateway/data
BIN_DIR       := $(HOME)/.research-gateway/bin
LAUNCHD_DIR   := $(APP_DIR)/launchd
LAUNCHAGENTS  := $(HOME)/Library/LaunchAgents
REPO_URL      := https://github.com/jkrumm/research-gateway.git

LABEL_GATEWAY    := com.jkrumm.research-gateway
LABEL_LIGHTPANDA := com.jkrumm.research-gateway-lightpanda
LABEL_DEPLOY     := com.jkrumm.research-gateway-deploy

HEALTH_URL := http://127.0.0.1:7780/health

.PHONY: mini-setup
mini-setup: ## Clone/update the deploy clone, install deps + pinned binaries, install the LaunchAgents
	@mkdir -p "$(DATA_DIR)" "$(BIN_DIR)"
	@if [ -d "$(APP_DIR)/.git" ]; then \
	  echo "  updating existing clone at $(APP_DIR)"; \
	  git -C "$(APP_DIR)" fetch origin master && git -C "$(APP_DIR)" reset --hard origin/master; \
	else \
	  echo "  cloning $(REPO_URL) -> $(APP_DIR)"; \
	  git clone --branch master "$(REPO_URL)" "$(APP_DIR)"; \
	fi
	cd "$(APP_DIR)" && bun install --frozen-lockfile --production
	@chmod +x "$(APP_DIR)"/scripts/*.sh
	"$(APP_DIR)/scripts/install-bins.sh"
	$(MAKE) launchd-install

.PHONY: launchd-install
launchd-install: ## Render the plist templates (__HOME__ substituted) and (re)load all three LaunchAgents (FORCE=1 skips the busy-job guard)
	@mkdir -p "$(LAUNCHAGENTS)"
	@if [ -z "$(FORCE)" ]; then \
	  n=$$(curl -sf --max-time 3 $(HEALTH_URL) 2>/dev/null | jq -r '(.jobs.running // 0) + (.jobs.queued // 0)' 2>/dev/null || echo 0); \
	  if [ "$${n:-0}" != "0" ]; then echo "refusing to install: $$n job(s) running/queued — jobs are abandoned, not resumed, on this box. FORCE=1 make launchd-install to reinstall anyway."; exit 1; fi; \
	fi
	@sed "s|__HOME__|$(HOME)|g" "$(LAUNCHD_DIR)/$(LABEL_LIGHTPANDA).plist.template" > "$(LAUNCHAGENTS)/$(LABEL_LIGHTPANDA).plist"
	@sed "s|__HOME__|$(HOME)|g" "$(LAUNCHD_DIR)/$(LABEL_GATEWAY).plist.template" > "$(LAUNCHAGENTS)/$(LABEL_GATEWAY).plist"
	@sed "s|__HOME__|$(HOME)|g" "$(LAUNCHD_DIR)/$(LABEL_DEPLOY).plist.template" > "$(LAUNCHAGENTS)/$(LABEL_DEPLOY).plist"
	@launchctl bootout "gui/$$(id -u)/$(LABEL_LIGHTPANDA)" 2>/dev/null || true
	@launchctl bootstrap "gui/$$(id -u)" "$(LAUNCHAGENTS)/$(LABEL_LIGHTPANDA).plist"
	@launchctl bootout "gui/$$(id -u)/$(LABEL_GATEWAY)" 2>/dev/null || true
	@launchctl bootstrap "gui/$$(id -u)" "$(LAUNCHAGENTS)/$(LABEL_GATEWAY).plist"
	@launchctl bootout "gui/$$(id -u)/$(LABEL_DEPLOY)" 2>/dev/null || true
	@launchctl bootstrap "gui/$$(id -u)" "$(LAUNCHAGENTS)/$(LABEL_DEPLOY).plist"
	@echo "installed $(LABEL_LIGHTPANDA), $(LABEL_GATEWAY), $(LABEL_DEPLOY)"

.PHONY: launchd-uninstall
launchd-uninstall: ## Unload and remove all three LaunchAgents
	@launchctl bootout "gui/$$(id -u)/$(LABEL_DEPLOY)" 2>/dev/null || true
	@launchctl bootout "gui/$$(id -u)/$(LABEL_GATEWAY)" 2>/dev/null || true
	@launchctl bootout "gui/$$(id -u)/$(LABEL_LIGHTPANDA)" 2>/dev/null || true
	@rm -f "$(LAUNCHAGENTS)/$(LABEL_DEPLOY).plist" "$(LAUNCHAGENTS)/$(LABEL_GATEWAY).plist" "$(LAUNCHAGENTS)/$(LABEL_LIGHTPANDA).plist"
	@echo "removed $(LABEL_GATEWAY), $(LABEL_LIGHTPANDA), $(LABEL_DEPLOY)"

.PHONY: launchd-status
launchd-status: ## launchctl state for all three LaunchAgents + curl :7780/health, /health/render, /health/ytdlp
	@launchctl print "gui/$$(id -u)/$(LABEL_GATEWAY)" 2>&1 | head -n 30
	@echo ""
	@launchctl print "gui/$$(id -u)/$(LABEL_LIGHTPANDA)" 2>&1 | head -n 20
	@echo ""
	@launchctl print "gui/$$(id -u)/$(LABEL_DEPLOY)" 2>&1 | head -n 20
	@echo ""
	@curl -s $(HEALTH_URL) || echo "$(HEALTH_URL) unreachable"
	@echo ""
	@curl -s http://127.0.0.1:7780/health/render || echo "health/render unreachable"
	@echo ""
	@curl -s http://127.0.0.1:7780/health/ytdlp || echo "health/ytdlp unreachable"
	@echo ""

.PHONY: launchd-restart
launchd-restart: ## Kickstart (restart) the gateway — refuses while jobs are running unless FORCE=1
	@if [ -z "$(FORCE)" ]; then \
	  n=$$(curl -sf --max-time 3 $(HEALTH_URL) 2>/dev/null | jq -r '(.jobs.running // 0) + (.jobs.queued // 0)' 2>/dev/null || echo 0); \
	  if [ "$${n:-0}" != "0" ]; then echo "refusing to restart: $$n job(s) running/queued — FORCE=1 make launchd-restart to restart anyway"; exit 1; fi; \
	fi
	@launchctl kickstart -k "gui/$$(id -u)/$(LABEL_GATEWAY)"
	@echo "restarted $(LABEL_GATEWAY)"

.PHONY: launchd-logs
launchd-logs: ## Tail all research-gateway LaunchAgent logs on this machine
	@tail -n 100 -f \
	  "$(HOME)/Library/Logs/research-gateway.log" \
	  "$(HOME)/Library/Logs/research-gateway.err" \
	  "$(HOME)/Library/Logs/research-gateway-lightpanda.log" \
	  "$(HOME)/Library/Logs/research-gateway-lightpanda.err" \
	  "$(HOME)/Library/Logs/research-gateway-deploy.log"

.PHONY: deploy
deploy: ## Run the app clone's mini-deploy.sh once, now (same script the poller runs every 2 minutes)
	@"$(APP_DIR)/scripts/mini-deploy.sh"

# ==============================================================================
# Validation
# ==============================================================================

.PHONY: check
check: ## typecheck + test (this checkout)
	@bun run typecheck && bun test

# ==============================================================================
# Help
# ==============================================================================

.PHONY: help
help:
	@echo ""
	@echo "  research-gateway"
	@echo ""
	@echo "  make check              typecheck + test"
	@echo ""
	@echo "  Mini native instance (:7780) + lightpanda sidecar (:7781) — see AGENTS.md"
	@echo "  make mini-setup         Clone/update the deploy clone, install deps + pinned bins, install the LaunchAgents"
	@echo "  make launchd-install    Render plists + (re)load all three LaunchAgents (FORCE=1 skips the busy-job guard)"
	@echo "  make launchd-uninstall  Unload + remove all three LaunchAgents"
	@echo "  make launchd-status     LaunchAgent state + curl :7780/health, /health/render, /health/ytdlp"
	@echo "  make launchd-restart    Kickstart (restart) the gateway (FORCE=1 skips the busy-job guard)"
	@echo "  make launchd-logs       Tail all research-gateway LaunchAgent logs"
	@echo "  make deploy             Run the app clone's mini-deploy.sh once, now"
	@echo ""

.DEFAULT_GOAL := help
