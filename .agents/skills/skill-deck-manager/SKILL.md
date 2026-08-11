---
name: skill-deck-manager
description: "Catalog の Inventory から active Projection を HTML チェックリストで整理する。Projection を削除せず切り替えたい時に使う。"
---

# Skill Deck Manager

Use this skill when the user wants to inspect, reduce, or switch the active global skills loaded from `~/.agents/skills`.

## Workflow

1. Set `MY_SKILLS_CATALOG_DIR` to the Catalog that owns `skills.lock.json`.
2. Resolve the Engine launcher as `ENGINE_ROOT/my-skills`.
3. Preview the selected Catalog first:

```bash
"$ENGINE_ROOT/my-skills" --catalog-dir "$MY_SKILLS_CATALOG_DIR" status
"$ENGINE_ROOT/my-skills" --catalog-dir "$MY_SKILLS_CATALOG_DIR" deck core
```

4. Start the dynamic HTML checklist:

```bash
"$ENGINE_ROOT/my-skills" --catalog-dir "$MY_SKILLS_CATALOG_DIR" ui
```

5. Open the printed localhost URL.
6. Keep checked the Skills that should remain active.
7. Submit the form and verify the refreshed counts.

The UI moves unchecked active skills to `~/.agents/skills-archive` and restores checked archived skills back to `~/.agents/skills`. It does not delete skills.

## Safety

- Do not use destructive delete commands for skill cleanup.
- Treat `~/.agents/skills` as the active projection and `~/.agents/skills-archive` as reversible storage.
- If a skill is unmanaged or untracked, call that out before applying changes.
- Prefer `core` first, then switch to `frontend`, `backend`, `workflow`, `design`, `writing`, or `research` only when needed.
