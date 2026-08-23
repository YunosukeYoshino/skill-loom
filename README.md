# Skill Loom

![A large Agent Skills Catalog becoming a small, deliberate runtime Projection](docs/assets/skill-loom-hero.png)

<p align="center"><strong>Keep the Catalog private. Keep the runtime small.</strong></p>

<p align="center">
  <a href="ARCHITECTURE.md"><strong>Architecture</strong></a> ·
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

## Architecture

The Engine resolves your Catalog Inventory into a local Projection: paths are validated, Decks are applied, Off transitions move through the system Trash, and Git writes stay scoped to the selected Catalog repository. The [architecture guide](ARCHITECTURE.md) covers the data flow, the Engine/Catalog ownership table, the entry points, and the project layout.

## Everyday commands

| Command                          | Purpose                                  |
| -------------------------------- | ---------------------------------------- |
| `./skill-loom status`            | Summarize Inventory and Projection state |
| `./skill-loom list`              | List Project Decks                       |
| `./skill-loom install-deck NAME` | Apply a Project Deck                     |
| `./skill-loom all`               | Preview full restoration                 |
| `./skill-loom all --apply`       | Restore the complete Inventory           |
| `./skill-loom ui`                | Open the local checklist UI              |

Management command families expose the same Catalog domain operations to shell workflows:

```bash
./skill-loom external list
./skill-loom external check
./skill-loom external preview owner/repo
./skill-loom external update SKILL --yes

./skill-loom custom check
./skill-loom custom update SKILL --yes

./skill-loom draft list
./skill-loom draft promote SKILL --yes
./skill-loom draft install SKILL --yes

./skill-loom deck show NAME
./skill-loom deck save NAME SKILL... --yes
./skill-loom deck apply NAME --yes
```

State-changing management commands print their targets and require confirmation. Use `--yes`
only in automation that has already reviewed the selected Catalog and target names.

The repository also ships Catalog-aware management Skills for adding, auditing, restoring, and updating External and Vendor Skills.

## Skill Loom vs. ad hoc Skill folders

|                                       | **Skill Loom** | Load everything | Hand-managed folders |
| ------------------------------------- | -------------- | --------------- | -------------------- |
| Private source separated from tooling | **Yes**        | Depends         | Depends              |
| Runtime subset is explicit            | **Yes**        | No              | Manual               |
| Inventory is reproducible             | **Lock v1**    | Partial         | No shared contract   |
| Removal is recoverable                | **Trash**      | n/a             | Depends              |
| CLI and local UI share one model      | **Yes**        | No              | No                   |

Skill Loom adds a small amount of structure in exchange for a clear ownership boundary and a Projection you can reproduce.

## Status

Skill Loom is an initial macOS release. The Engine/Catalog boundary and legacy colocated fallback are stable enough for migration, but cross-platform Trash behavior is intentionally out of scope for this release.

Read the [migration guide](docs/migration.md) before connecting an existing portfolio. For bugs, include the Engine revision, macOS and Bun versions, command, and sanitized output as described in [Support](SUPPORT.md).

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), keep tests on the synthetic or temporary Catalog boundary, and report security issues through [SECURITY.md](SECURITY.md).
