# Contributing to Skill Loom

Thank you for helping improve Skill Loom.

## Development setup

Skill Loom currently targets macOS and requires Bun, Python 3.11+, and uv.

```bash
git clone https://github.com/YunosukeYoshino/skillloom.git
cd skillloom
bun install
bun install --cwd app/frontend
make typecheck
make test
make publication-check
```

## Change workflow

1. Open an issue for behavior changes or security-boundary changes.
2. Add a failing test through a public seam before changing behavior.
3. Keep Engine-owned code independent from real Catalog data.
4. Run all three verification commands above.
5. Use a Conventional Commit title in the pull request.

Tests must use `examples/catalog` or a temporary Catalog. Do not add real Inventory Locks, personal Skills, Agent definitions, or Project Decks to this repository.

## Pull requests

Describe the user-visible result, test evidence, security impact, and compatibility trade-offs. Keep unrelated refactors in separate pull requests.
