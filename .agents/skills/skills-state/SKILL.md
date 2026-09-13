---
name: skills-state
description: "Inventory にある skill 個別の Projection 状態（active / archive / off）を CLI で切り替える。deck 全体ではなく1つだけ動かしたい時に使う。トリガー: 「スキルを有効化」「〜をactiveに」「〜をarchiveに」「スキルをオフに」「activate/archive skill」"
---

# Skills State

Use this skill when the user wants to move one or a few managed skills between Active, Archive, and Off without touching the rest of the Projection.

## Workflow

### Step 1: Select the Catalog and Engine

Set `MY_SKILLS_CATALOG_DIR` to the Catalog that owns `skills.lock.json`, and resolve the Engine launcher as `ENGINE_ROOT/skill-loom`.

Verify: `MY_SKILLS_CATALOG_DIR` is set and points at an existing `skills.lock.json`.

### Step 2: Check the current state

```bash
"$ENGINE_ROOT/skill-loom" --catalog-dir "$MY_SKILLS_CATALOG_DIR" status
```

Verify: the skill names the user gave are part of the tracked Inventory.

### Step 3: Set the state

```bash
"$ENGINE_ROOT/skill-loom" --catalog-dir "$MY_SKILLS_CATALOG_DIR" skill <active|archive|off> <names...> -y
```

- `active`: restores from Archive, or installs managed skills that are Off (External via the skills CLI, Custom from the Catalog repo).
- `archive`: moves the files to `~/.agents/skills-archive`, removes the agent-facing symlinks, and drops the skill from the skills CLI lock so a later `skills update` won't resurrect it.
- `off`: trashes the Projection copies and drops the skill from the skills CLI lock.

Verify: rerun `status`; the counts moved. For `active`, `~/.claude/skills/<name>` resolves into the Active directory.

## Safety

- Unknown names abort with exit 2 before any write. Register the skill first (skills-add, `draft promote`) and retry.
- `off` is trash-based and reversible via `skill active`, but re-installing an External Skill hits the network again.
- `-y` skips the confirmation prompt; keep it for agent-driven runs, drop it for interactive ones.
- The previous Active set is saved to the `_last` preset before each change; `preset restore` undoes it.
