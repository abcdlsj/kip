# Kip — Electrobun + Bun + Pi
#
#   make install   install dependencies
#   make dev       build the view, then launch the dev app
#   make open      launch the last dev build without rebuilding
#   make release   full stable build (typecheck, icons, view, bundle)

SHELL := /bin/bash

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Darwin)
PLATFORM := macos
else ifeq ($(UNAME_S),Linux)
PLATFORM := linux
else
PLATFORM := win
endif

ifeq ($(UNAME_M),arm64)
ARCH := arm64
else
ARCH := x86_64
endif

BUILD_DIR := build
DEV_DIR   := $(BUILD_DIR)/dev-$(PLATFORM)-$(ARCH)
REL_DIR   := $(BUILD_DIR)/stable-$(PLATFORM)-$(ARCH)
DEV_APP   := $(DEV_DIR)/Kip-dev.app
REL_APP   := $(REL_DIR)/Kip.app

BUN := bun
ELECTROBUN := $(BUN)x electrobun

.DEFAULT_GOAL := help

.PHONY: help install dev open release

help:
	@echo "make install   install dependencies (bun install)"
	@echo "make dev       compile the view, then launch $(DEV_APP)"
	@echo "make open      launch the existing dev app without rebuilding"
	@echo "make release   typecheck + icons + view + stable bundle ($(REL_DIR), artifacts/)"

install:
	$(BUN) install

# Compile the React view, let electrobun re-wrap the bun main process and the
# views into $(DEV_APP), then run it in the foreground (Ctrl-C stops it).
dev:
	@test -d node_modules/electrobun || { echo "run 'make install' first"; exit 1; }
	$(BUN) run build:view
	$(BUN) run build:cli
	$(ELECTROBUN) dev

# Skip icons/vite/electrobun entirely: handy when only re-opening the app and
# nothing in src/ has changed since the last 'make dev'.
open:
	@test -d "$(DEV_APP)" || { echo "no $(DEV_APP) yet: run 'make dev'"; exit 1; }
	open "$(DEV_APP)"

# Same pipeline as 'bun run build'; the final .app and the dmg/zip land in
# $(REL_DIR) and artifacts/.
release:
	@test -d node_modules/electrobun || { echo "run 'make install' first"; exit 1; }
	$(BUN) run build
	@echo
	@echo "release app: $(REL_APP)"
	@test -d artifacts && { echo "artifacts:"; ls -1 artifacts; } || true
