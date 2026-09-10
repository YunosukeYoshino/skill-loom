# 1. Namespaced External Skills

Date: 2026-08-29

## Status

Accepted

## Context

Skill Loom manages an inventory of Agent Skills across multiple external repositories and local custom skills. Different upstream repositories often provide skills with identical names (e.g. `web-design`, `search`, `test`).

However:

- Local agent runners (Claude Code, Codex, Antigravity) discover skills by scanning single-depth directories in `~/.agents/skills/{name}/SKILL.md` and read the `name:` property from the YAML frontmatter.
- Previously, Skill Loom treated all skill names as globally unique flat kebab-case names. When importing an external skill with an existing name, it was either skipped, rejected, or required a Vendor Skill override.
- We need a first-class mechanism to allow coexisting external skills from different repositories without namespace collisions, while maintaining full compatibility with the existing Agent Skills ecosystem.

## Decision

We adopt a **Flat Namespacing and Aliasing Model** with the following rules:

1. **Identifier and Directory Format (Separator Flattening)**:
   - Namespaced skills use the format `{owner}--{skill-name}` (e.g. `vercel--next-best-practices`) or a user-defined alias.
   - `/` cannot be used: agents discover `~/.agents/skills/{name}/SKILL.md` as a single-depth directory.
   - A single `-` cannot be used: owner names and skill names are already kebab-case (`vercel-labs`, `next-best-practices`), so `vercel-labs-next-best-practices` cannot be split. `--` is the unambiguous flatten.
   - This keeps the directory structure at `~/.agents/skills/` single-depth and flat, preserving compatibility with agents and the `skills` CLI.

2. **On-Conflict / Opt-in Application**:
   - By default, skills imported without conflict retain their concise upstream names.
   - Namespacing is applied automatically or interactively when a name collision is detected (with Custom, Vendor, or existing External skills, including an already-active directory), or when explicitly specified via `--as <alias>` or `--prefix` (force `{owner}--{name}` even without a collision).

3. **Inventory Lock Schema & Metadata**:
   - The key in `skills.lock.json` under `external` matches the Catalog / runtime name (e.g. `"vercel--next-best-practices"`).
   - The upstream skill name within the source repository is preserved in the `installSkill` property (e.g. `"installSkill": "next-best-practices"`).
   - Schema version remains v1, leveraging the existing `installSkill` field.

4. **Frontmatter Synchronization on Projection**:
   - When deploying or linking an aliased / namespaced skill into `~/.agents/skills/{name}`, the YAML frontmatter `name:` inside `SKILL.md` is synchronized with the deployed directory name so that agents resolve and invoke the skill unambiguously.
   - The skills CLI always writes the upstream folder name. Deploy therefore stashes any pre-existing upstream directory, installs that one skill, moves the fresh install onto the deploy name, syncs frontmatter, then restores the stash so both skills remain on disk.

5. **Conflict Resolution Flow**:
   - **Interactive mode (TTY)**: When a collision occurs during skill import, the CLI prompts the user with options:
     1. Apply namespace prefix (`{owner}--{name}`)
     2. Specify a custom alias
     3. Fork as a Catalog-owned Vendor Skill
     4. Skip
   - **Non-interactive mode (CI / `--yes`)**: Automatically disambiguate using `{owner}--{name}`.

## Consequences

### Positive

- Enables importing multiple skills with identical names from different repositories.
- Zero breaking changes to existing Decks, presets, or short skill names.
- Compatible with all local agent engines without requiring nested directory support from external tools.

### Negative / Trade-offs

- Running a namespaced skill requires referencing its prefixed or aliased name in prompts/commands.
- Projection deployment must handle frontmatter synchronization cleanly during file sync.
