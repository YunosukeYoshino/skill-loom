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

- An External Skill is always deployed under its upstream name. Skill Loom never generates `{owner}--{name}`.
- A name already used by a Custom Skill, a Vendor Skill, an External Skill from another source, or an on-disk directory whose skills CLI lock entry points to another (or unknown) source is a conflict. The candidate is rejected; the user skips it, removes the existing skill, or forks it as a Vendor Skill.
- An on-disk directory whose skills CLI lock entry points to the same source is the same skill and can be registered or reinstalled.
- `skills-add --prefix` and the interactive "namespace" option are removed. An explicit `--as <alias>` and existing `installSkill` lock entries stay supported for deliberate renames.

## Consequences

- Skill names are stable and match upstream, so cross-skill invocation works.
- Two sources cannot provide the same skill name at the same time; the user must choose one (or vendor-fork).
