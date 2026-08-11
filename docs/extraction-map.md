# Engine and Catalog extraction map

This document records the publication boundary for the initial Skill Loom extraction.

## Engine-owned allowlist

- `skill-loom` CLI launcher (`my-skills` compatibility wrapper included)
- `app/backend/`, `app/shared/`, and `app/frontend/`
- generic repository-management Skills after Catalog assumptions are removed
- process-level, domain-boundary, and management-script tests
- `schemas/` and `examples/catalog/`
- build, type-check, lint, secret-scan, and CI configuration
- public documentation and distribution assets

The public repository must start from this allowlist and a new Git history. Private history and ignored files are not publication inputs.

## Catalog-owned data

- `skills.lock.json` and `.skills-ignore.json`
- `skills/`, `vendor/`, `upstream/`, and `drafts/`
- `project-decks/` and `shared-decks/`
- `agents/`
- private presets and environment configuration

The real Core Deck is Catalog-owned. The engine provides only its loading and union behavior. The public example uses an empty Core Deck.

## Known root coupling

The current engine derives one repository root from `import.meta.dir`. That root currently controls:

- Inventory Lock and ignore paths
- Custom Skill source paths
- Shared Deck and Draft Skill paths
- repository-local management Skill paths
- Git discovery, staging, and commits

The extraction must replace these uses with an explicit Engine Root or Catalog Root. Artifact-specific environment overrides remain available for isolated tests.

## Migration order

1. Characterize existing behavior at the agreed public seams.
2. Add Catalog Root selection while preserving the colocated fallback.
3. Move Catalog Git operations and reject paths outside the Catalog repository.
4. Validate Inventory Lock version 1 and all Catalog-relative paths.
5. Make Custom Skill, Draft Skill, Vendor Skill, Deck, and management-Skill operations Catalog-aware.
6. Add the synthetic Catalog, public documentation, CI, and publication checks.
7. Run the public engine against both the synthetic Catalog and the private Catalog.
8. Pin the public engine in the private Catalog and remove duplicated engine code.

Each step is a separate Conventional Commit. No engine code is removed from the private Catalog before both Catalog scenarios pass.
