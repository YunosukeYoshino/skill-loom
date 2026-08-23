---
name: skill-deck-manager
description: "Catalog の Inventory から active Projection を HTML チェックリストで整理する。Projection を削除せず切り替えたい時に使う。トリガー: 「デッキ整理」「projection 切替」「active スキル整理」「スキルを減らす」"
---

# Skill Deck Manager

Use this skill when the user wants to inspect, reduce, or switch the active global skills loaded from `~/.agents/skills`.

## Workflow

### Step 1: Select the Catalog and Engine

Set `MY_SKILLS_CATALOG_DIR` to the Catalog that owns `skills.lock.json`, and resolve the Engine launcher as `ENGINE_ROOT/skill-loom`.

Verify: `MY_SKILLS_CATALOG_DIR` is set and points at an existing `skills.lock.json`.

### Step 2: Preview the selected Catalog

```bash
"$ENGINE_ROOT/skill-loom" --catalog-dir "$MY_SKILLS_CATALOG_DIR" status
"$ENGINE_ROOT/skill-loom" --catalog-dir "$MY_SKILLS_CATALOG_DIR" list
```

Verify: both commands report the Inventory of the selected Catalog without errors.

### Step 3: Start the HTML checklist

```bash
"$ENGINE_ROOT/skill-loom" --catalog-dir "$MY_SKILLS_CATALOG_DIR" ui
```

Open the printed localhost URL.

Verify: the checklist lists the active skills of the selected Catalog.

### Step 4: Switch the Projection

Keep checked the Skills that should remain active, then submit the form.

Verify: the refreshed counts match the number of kept skills.

The UI moves unchecked active skills to `~/.agents/skills-archive` and restores checked archived skills back to `~/.agents/skills`. It does not delete skills.

## Safety

- Do not use destructive delete commands for skill cleanup.
- Treat `~/.agents/skills` as the active projection and `~/.agents/skills-archive` as reversible storage.
- If a skill is unmanaged or untracked, call that out before applying changes.
- Prefer `core` first, then switch to `frontend`, `backend`, `workflow`, `design`, `writing`, or `research` only when needed.
