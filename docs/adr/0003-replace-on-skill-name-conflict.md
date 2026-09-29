# 3. Replace on Skill Name Conflict

Date: 2026-09-28

## Status

Accepted. Partially amends [0002](0002-no-namespaced-external-skills.md).

## Context

ADR 0002 rejects every Skill Name Conflict and asks the user to remove the existing skill first. In practice most conflicts are with skills the user already keeps in Active or Archive — an External Skill from another source, or a directory installed outside the Inventory. Switching meant removing it (which also strips it from Project Decks), then adding the new one, then restoring its state and deck membership by hand.

## Decision

A conflict can be resolved by **Skill Replacement**. When adding, a replaceable conflict is not silently skipped: it needs approval. Each selected conflicting skill must be resolved to either "keep existing" or "replace" — neither is preselected — before the add can proceed. To support the choice, both sides are shown with their source (an unmanaged directory shows as unknown), state, Project Deck count, and description.

- Replaceable owners: an External Skill from another source, and an on-disk directory that is not in the Inventory. Custom and Vendor Skills stay non-replaceable: they are Catalog-authored and must not disappear as a side effect of adding something.
- The name does not change, so the Active / Archive state and Project Deck membership carry over.
- The old skill is set aside before installing and restored if the install or registration fails. Only after success is the old External Skill removed from management, or the unmanaged directory moved to the trash (it may not be re-fetchable).
- A legacy alias entry (`installSkill`) whose key is the name counts as an other-source External Skill and is replaceable.
- A legacy alias registered under a different key that installs the same upstream name from another source is not replaceable; it stays rejected. Nothing sits at that name to swap out, and replacing it would leave two entries managing the same upstream skill.
- A name provided twice within the same source (duplicate path) is not replaceable; it stays rejected.
- Replacement is offered in the Web UI only. `skills-add` gets no `--replace` until there is a need for it.

## Consequences

- Switching a skill's source is one reversible step instead of three manual ones.
- 0002's invariant still holds: one name, one managed skill.
- Custom / Vendor conflicts still require an explicit remove or vendor-fork.
