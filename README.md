# Skill Loom

![Skill Loom turns an Agent Skills Inventory into a runtime Projection](docs/assets/skillloom-hero.png)

Skill Loom is a local Catalog and Projection manager for Agent Skills. It keeps authored Skill data separate from the reusable management engine, then applies a selected Deck as a small runtime Projection for supported agents.

> [!IMPORTANT]
> Skill Loom is being extracted from `my-skills`. The public interface and Catalog contract are defined, but the first standalone release is not ready yet.

## Overview

Agent Skill collections grow quickly. Keeping every Skill in every agent's runtime context makes discovery noisy and makes private material difficult to separate from reusable tooling.

Skill Loom keeps the complete Inventory in a Catalog. It then applies a Core Deck or Project Deck to produce the Active Projection used by local agents. Catalog data stays outside the engine repository and remains the Catalog owner's source of truth.

## Quick Start

The following workflow is the target for the first standalone release:

```bash
git clone https://github.com/YunosukeYoshino/skillloom.git
cd skillloom
bun install
make test
./my-skills ui --catalog-dir examples/catalog
```

Skill Loom initially supports macOS. Projection removal uses the system Trash command. Linux and Windows support are outside the first release.

## Features

- Keep private Custom Skills, Vendor Skills, Draft Skills, Agents, and Decks in a separate Catalog.
- Select a Catalog with `--catalog-dir` or `MY_SKILLS_CATALOG_DIR`.
- Apply Core Deck and Project Deck recipes without changing Active, Archive, or Off semantics.
- Manage the same Catalog through the CLI and local Web UI.
- Validate Inventory Locks and reject paths that escape the Catalog Root.
- Record optional automatic commits in the Catalog repository, not the engine repository.

## Usage

Use an explicit Catalog for normal commands:

```bash
./my-skills --catalog-dir /path/to/catalog status
./my-skills --catalog-dir /path/to/catalog list
./my-skills ui --catalog-dir /path/to/catalog
```

Wrappers can set the Catalog once:

```bash
export MY_SKILLS_CATALOG_DIR=/path/to/catalog
./my-skills status
```

If neither option is present, Skill Loom uses the engine checkout as the Catalog Root. This fallback preserves the former colocated layout.

## Project Structure

```text
app/                 Engine application code and shared API contracts
examples/catalog/    Empty synthetic Catalog for tests and onboarding
schemas/             Versioned Inventory Lock schemas
skills/              Generic management Skills shipped with the engine
tests/               CLI, HTTP, security-boundary, and smoke tests
docs/                Catalog contract, security model, and migration guides
```

Catalog-owned data is not stored in these directories. A Catalog contains its Inventory Lock, ignore list, Custom Skills, Vendor and Upstream trees, Draft Skills, Project Decks, Shared Decks, and Agent definitions.

