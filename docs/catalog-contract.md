# Catalog Contract

A Catalog is a separate directory or Git repository selected with `--catalog-dir PATH` or `MY_SKILLS_CATALOG_DIR`.

## Required files

- `skills.lock.json`: Inventory Lock v1. See [`schemas/inventory-lock-v1.schema.json`](../schemas/inventory-lock-v1.schema.json).
- `.skills-ignore.json`: `{ "ignore": [] }` plus names intentionally outside the Inventory.
- `shared-decks/core.json`: the baseline Deck; it may contain an empty `skills` array.

## Optional trees

```text
skills/{category}/{name}/       Custom Skills
vendor/{name}/                  Customized External Skills
upstream/{name}/                Vendor comparison baselines
drafts/skills/{category}/{name} Draft Skills
project-decks/*.json            Project Decks
shared-decks/*.json             Shared Decks
agents/                         Agent definitions
```

Lock paths are relative to the Catalog Root. Absolute paths, `..` traversal, and symlinks that resolve outside the Catalog are rejected.

When automatic commits are enabled, Skill Loom discovers and commits in the Catalog repository. The Engine checkout is not used as the Git owner for Catalog changes.
