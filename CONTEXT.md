# Skill Loom

Skill Loom is a local management engine for an Agent Skills portfolio. It keeps the complete Inventory in a Catalog and produces a small runtime Projection for local agents.

## Language

- **Engine Root**: reusable executable code, Web UI, schemas, examples, tests, and generic management Skills.
- **Catalog Root**: Inventory data and authored assets. Catalog-relative paths remain inside this root.
- **Inventory**: every managed Skill recorded by the Catalog and Inventory Lock.
- **Projection**: the runtime subset represented by Active, Archive, the skills CLI Lock, and agent-facing links.
- **Custom Skill**: a Skill authored in the Catalog.
- **External Skill**: a registered Skill sourced from another repository.
- **Vendor Skill**: a Catalog-owned customization that overrides an External Skill of the same name.
- **Draft Skill**: an authored Skill that joins the Inventory only after promotion.
- **Core Deck**: the Catalog baseline automatically unioned when a Project Deck is applied.
- **Project Deck**: a Catalog recipe for a codebase or work area.
- **Active / Archive / Off**: available now / retained for later / absent from the Projection.
