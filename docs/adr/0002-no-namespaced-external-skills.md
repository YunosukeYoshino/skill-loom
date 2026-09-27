# 2. No Namespaced External Skills

Date: 2026-09-26

## Status

Accepted. Supersedes [0001](0001-namespaced-external-skills.md).

## Context

ADR 0001 introduced automatic `{owner}--{name}` namespacing when an External Skill name collided. In practice:

- Renamed skills are hard to manage: the lock key, the deployed directory, the frontmatter `name`, and the upstream name drift apart, and every install / restore / update path needs stash-and-rename logic.
- Skills that invoke other skills by name break, because the invoked skill no longer exists under its upstream name.
- The collision check treated any directory on disk as foreign, so a skill already installed from the _same_ source (but missing from the Inventory Lock) was reported as a collision and blocked with "choose a different alias".

## Decision

One skill name, one managed skill. Which of two same-named skills should win is a case-by-case call, so Skill Loom never lets them coexist.

- An External Skill is always deployed under its upstream name. Skill Loom never generates `{owner}--{name}` and no longer accepts new aliases (`skills-add --as` and `--prefix` are removed).
- A name already used by a Custom Skill, a Vendor Skill, an External Skill from another source, or an active / archived directory whose skills CLI lock entry points to another (or unknown) source is a conflict. The candidate is not installed and not registered. To switch, remove the existing skill first, or fork it as a Vendor Skill.
- An on-disk directory whose skills CLI lock entry points to the same source is the same skill and can be registered or reinstalled.
- `skills-add` resolves candidates before calling the skills CLI, so an unfiltered add never overwrites a same-named skill from another source.
- Existing lock entries with `installSkill` keep working (restore / update) for backward compatibility, but no new ones are created.

## Consequences

- Skill names are stable and match upstream, so cross-skill invocation works.
- Two sources cannot provide the same skill name at the same time; the user explicitly chooses one.
