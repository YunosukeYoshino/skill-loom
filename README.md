# Skill Loom

![Skill Loom turns an Agent Skills Inventory into a runtime Projection](docs/assets/skillloom-hero.png)

[![CI](https://github.com/YunosukeYoshino/skillloom/actions/workflows/ci.yml/badge.svg)](https://github.com/YunosukeYoshino/skillloom/actions/workflows/ci.yml)

Skill Loom is a local Catalog and Projection manager for Agent Skills. It keeps private authored assets in a separate Catalog, then uses a reusable engine to project only the Skills each local agent needs.

> [!IMPORTANT]
> The initial release supports macOS. Off transitions use the system Trash so Skill removal remains recoverable.

## Overview

Agent Skill collections grow quickly. Loading the entire collection into every agent makes discovery noisy and couples private material to reusable tooling.

Skill Loom separates those concerns:

- The **Engine** provides the CLI, local Web UI, schemas, validation, and Projection operations.
- A **Catalog** owns the Inventory Lock, Custom/Vendor/Upstream Skills, Drafts, Decks, and Agent definitions.
- A **Projection** keeps a selected subset Active while retaining the rest in Archive or Off state.

## Quick Start

```bash
git clone https://github.com/YunosukeYoshino/skillloom.git
cd skillloom
bun install
bun install --cwd app/frontend
make test
./my-skills --catalog-dir examples/catalog status
./my-skills --catalog-dir examples/catalog list
```

Start the local UI with the same synthetic Catalog:

```bash
./my-skills --catalog-dir examples/catalog ui
```

## Features

- Select a Catalog with `--catalog-dir` or `MY_SKILLS_CATALOG_DIR`.
- Manage the same Inventory through the CLI and local Web UI.
- Apply Core and Project Deck recipes without changing Active, Archive, or Off semantics.
- Validate Inventory Lock v1 and reject absolute paths, traversal, and symlink escapes.
- Promote Draft Skills and commit changes in the Catalog repository.
- Restore, audit, and update External and Vendor Skills with Catalog-aware management Skills.

## Usage

Use an explicit Catalog for scripts and automation:

```bash
./my-skills --catalog-dir /path/to/catalog status
./my-skills --catalog-dir /path/to/catalog list
./my-skills --catalog-dir /path/to/catalog deck core
```

Set the Catalog once for a shell session:

```bash
export MY_SKILLS_CATALOG_DIR=/path/to/catalog
./my-skills status
```

If neither selector is present, the Engine checkout is used as a legacy colocated Catalog.

See [Catalog contract](docs/catalog-contract.md), [security model](docs/security-model.md), and [migration guide](docs/migration.md) before connecting an existing portfolio.

## Project Structure

```text
app/                 Engine backend, Web UI, and shared API contracts
.agents/skills/      Catalog-aware management Skills
examples/catalog/    Empty synthetic Catalog for onboarding and smoke tests
schemas/             Versioned Inventory Lock schemas
scripts/             Publication and secret-scan checks
tests/               CLI, HTTP, path-boundary, and management-script tests
docs/                Catalog, security, and migration documentation
```
