# Architecture

Skill Loom is a local-first control plane for Agent Skills. The public **Engine** turns a private **Catalog** into a reproducible runtime **Projection** without owning your private material. This guide covers the data flow, the ownership boundary, the entry points, and the repository layout.

## Data flow: Catalog to Projection

```text
Private Catalog                 Skill Loom Engine              Local Projection

skills.lock.json  ─┐
skills/           ─┤             validate paths
vendor/           ─┤             resolve Inventory            ~/.agents/skills/
drafts/           ─┼──────────▶  apply Decks      ──────────▶  ~/.agents/skills-archive/
project-decks/    ─┤             move via Trash                agent-specific links
shared-decks/     ─┤             scope Git writes
agents/           ─┘
```

Select the Catalog per command:

```bash
./skill-loom --catalog-dir /path/to/catalog status
```

Or select it once for a shell session:

```bash
export MY_SKILLS_CATALOG_DIR=/path/to/catalog
./skill-loom status
```

If neither selector is present, the Engine Root is used as a legacy colocated Catalog for migration compatibility.

## Entry points

The `./skill-loom` launcher resolves `--catalog-dir` before Bun loads, so the CLI and the Web UI receive the same Catalog Root. It routes `ui` to the local Web UI server (`app/backend/index.ts`, where Hono owns the public port) and every other subcommand to the CLI (`app/backend/cli.ts`).

## Engine and Catalog boundaries

| Engine owns                         | Catalog owns                         |
| ----------------------------------- | ------------------------------------ |
| CLI and local Web UI                | Inventory Lock and ignore rules      |
| Inventory Lock v1 schema            | Custom Skills and Drafts             |
| Validation and Projection rules     | Vendor Skills and upstream baselines |
| Catalog-aware management Skills     | Project, Shared, and Core Decks      |
| Synthetic fixtures and public tests | Agent definitions                    |

Catalog-relative paths are resolved against the real Catalog Root. Absolute paths and paths that resolve outside the Catalog through `..` or symlinks are rejected before file operations.

## Project structure

```text
app/                 Engine backend, Web UI, and shared API contracts
.agents/skills/      Catalog-aware management Skills
examples/catalog/    Empty synthetic Catalog for onboarding and tests
schemas/             Versioned Inventory Lock schemas
scripts/             Publication and secret-scan checks
tests/               CLI, HTTP, path-boundary, and management tests
docs/                Catalog, security, and migration documentation
```

## Further reading

- [Catalog contract](docs/catalog-contract.md)
- [Security model](docs/security-model.md)
- [Migration guide](docs/migration.md)
