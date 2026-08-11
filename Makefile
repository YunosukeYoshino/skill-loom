.PHONY: help build typecheck test publication-check

help:
	@echo "bun install && bun install --cwd app/frontend"
	@echo "make build | typecheck | test | publication-check"

build:
	cd app/frontend && bun run build

typecheck:
	bunx tsc --noEmit -p tsconfig.json
	cd app/frontend && bun run typecheck

test:
	bun test app/backend/
	bash tests/test-skill-loom.sh

publication-check:
	bash scripts/publication-check
