# Skill Loom

![A large Agent Skills Catalog becoming a small, deliberate runtime Projection](docs/assets/skill-loom-hero.png)

<p align="center"><strong>Keep the Catalog private. Keep the runtime small.</strong></p>

<p align="center">
  <a href="docs/catalog-contract.md"><strong>Catalog contract</strong></a> ·
  <a href="docs/security-model.md"><strong>Security model</strong></a> ·
  <a href="docs/migration.md"><strong>Migration guide</strong></a> ·
  <a href="#quick-start"><strong>Quick start</strong></a>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-0B1F3A?style=for-the-badge"></a>
  <a href="SUPPORT.md"><img alt="macOS" src="https://img.shields.io/badge/platform-macOS-0B1F3A?style=for-the-badge&logo=apple&logoColor=white"></a>
  <a href="https://github.com/YunosukeYoshino/skill-loom/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/YunosukeYoshino/skill-loom/ci.yml?branch=main&style=for-the-badge&label=CI"></a>
</p>

---

## What is Skill Loom?

Skill Loom is a **local-first control plane for Agent Skills**. It keeps reusable management code in a public Engine while your authored Skills, Decks, Agent definitions, and Inventory stay in a separate Catalog you control.

The distinction is small but important:

- **Inventory** is everything you track.
- **Projection** is the deliberate subset your agents can see right now.
- **Engine** turns the first into the second without owning your private material.

The result is a reproducible Skill collection without loading the whole collection into every agent session.

## Quick start

```bash
git clone https://github.com/YunosukeYoshino/skill-loom.git
cd skill-loom
bun install --frozen-lockfile
bun install --cwd app/frontend --frozen-lockfile

./skill-loom --catalog-dir examples/catalog status
./skill-loom --catalog-dir examples/catalog list
```

The bundled Catalog is intentionally empty. Copy it into a separate repository when you are ready to add your own Inventory:

```bash
cp -R examples/catalog ../my-skill-catalog
./skill-loom --catalog-dir ../my-skill-catalog status
```

Start the local checklist UI against the same Catalog:

```bash
MY_SKILLS_VITE=1 ./skill-loom --catalog-dir ../my-skill-catalog ui
```

> [!IMPORTANT]
> Skill Loom currently targets macOS. Off transitions use the system Trash so removals stay recoverable. The local UI has no authentication and should remain bound to localhost.

## Why Skill Loom

- **Private by construction.** The public Engine never needs your real Inventory Lock, authored Skills, Decks, or Agent definitions.
- **A smaller runtime surface.** Active, Archive, and Off states make the agent-visible Projection explicit instead of incidental.
- **One reproducible Inventory.** Inventory Lock v1 records Custom, External, and Vendor sources in a validated file contract.
- **Recoverable operations.** Off transitions use Trash, and Git mutations are scoped to the selected Catalog repository.
- **One model across CLI and UI.** Both interfaces resolve the same Catalog Root and apply the same domain rules.

## How it works

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

## Engine and Catalog ownership

| Engine owns | Catalog owns |
| --- | --- |
| CLI and local Web UI | Inventory Lock and ignore rules |
| Inventory Lock v1 schema | Custom Skills and Drafts |
| Validation and Projection rules | Vendor Skills and upstream baselines |
| Catalog-aware management Skills | Project, Shared, and Core Decks |
| Synthetic fixtures and public tests | Agent definitions |

Catalog-relative paths are resolved against the real Catalog Root. Absolute paths, `..` traversal, and symlinks that escape the Catalog are rejected before file operations.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `./skill-loom status` | Summarize Inventory and Projection state |
| `./skill-loom list` | List Project Decks |
| `./skill-loom install-deck NAME` | Apply a Project Deck |
| `./skill-loom all` | Preview full restoration |
| `./skill-loom all --apply` | Restore the complete Inventory |
| `./skill-loom ui` | Open the local checklist UI |

The repository also ships Catalog-aware management Skills for adding, auditing, restoring, and updating External and Vendor Skills.

## Skill Loom vs. ad hoc Skill folders

| | **Skill Loom** | Load everything | Hand-managed folders |
| --- | --- | --- | --- |
| Private source separated from tooling | **Yes** | Depends | Depends |
| Runtime subset is explicit | **Yes** | No | Manual |
| Inventory is reproducible | **Lock v1** | Partial | No shared contract |
| Removal is recoverable | **Trash** | n/a | Depends |
| CLI and local UI share one model | **Yes** | No | No |

Skill Loom adds a small amount of structure in exchange for a clear ownership boundary and a Projection you can reproduce.

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

## Status

Skill Loom is an initial macOS release. The Engine/Catalog boundary and legacy colocated fallback are stable enough for migration, but cross-platform Trash behavior is intentionally out of scope for this release.

Read the [migration guide](docs/migration.md) before connecting an existing portfolio. For bugs, include the Engine revision, macOS and Bun versions, command, and sanitized output as described in [Support](SUPPORT.md).

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), keep tests on the synthetic or temporary Catalog boundary, and report security issues through [SECURITY.md](SECURITY.md).
