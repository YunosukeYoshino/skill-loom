# Skill Loom

Skill Loom is a local management engine for an Agent Skills portfolio. It keeps the complete Inventory in a Catalog and produces a small runtime Projection for local agents.

## Language

### Inventory and Projection

**Inventory**: The complete set of managed Skills. The Catalog and its Inventory Lock are authoritative.

**Projection**: The selected runtime state derived from the Inventory. Active, Archive, the skills CLI Lock, and agent-facing symlinks together represent the Projection.

**Inventory Lock**: The versioned file that records which Skills belong to the Inventory.

### Roots

**Engine Root**: The root that contains executable code, the Web UI, generic management Skills, schemas, examples, tests, and distribution assets.

**Catalog Root**: The root that contains Inventory data and authored assets. Catalog-relative paths must not resolve outside this root.

### Skill kinds

**Skill**: A named instruction set centered on `SKILL.md`.

**Custom Skill**: A Skill authored and managed in the Catalog.

**External Skill**: A Skill from another repository that is registered in the Inventory Lock.

**Vendor Skill**: A customized External Skill stored in the Catalog. It overrides the External Skill with the same name.

**Draft Skill**: A Skill that is not registered in the Inventory Lock until explicit promotion.

### Decks

**Deck**: A named recipe that selects Skills from the Inventory for a Projection.

**Core Deck**: The Catalog-owned baseline Deck. Its loading, inheritance, and automatic union behavior are implemented by the engine.

**Project Deck**: A Catalog-owned Deck for one codebase or work area.

### Projection states

**Active**: A Skill is in the current Projection and is available to supported agents.

**Archive**: A Skill is outside the current Projection but is retained for later use.

**Off**: A Skill is in the Inventory but is not present in the Projection.

### Operations

**Apply**: Update the Projection from a selected Deck or UI selection.

**Restore**: Rebuild the complete Inventory from the Inventory Lock.

**Agent**: An agent definition managed separately from Skills. Agents are not part of Skill discovery.

