# Security Model

Skill Loom manages local files and local agent Projection directories. It is not a hosted service and does not provide multi-user isolation.

## Trust boundaries

- The selected Catalog is trusted authored input, but its Inventory Lock is parsed from `unknown` and validated before use.
- Catalog-relative paths must remain within the real Catalog Root after symlink resolution.
- Git staging and commits are scoped to the Catalog repository.
- Off transitions use Trash so removal remains recoverable.
- External Skill installation and GitHub access cross process and network boundaries; review the named source before approving those commands.

## Local Web UI

The UI is intended for localhost use. It has no authentication or authorization layer. Keep the default local bind and do not place it behind a public tunnel or internet-facing proxy.

## Publication boundary

The public repository is exported from an allowlist. CI rejects root Inventory data, authored Skill trees, private Deck trees, environment files, and credential-shaped files. Secret scan output reports only file locations and rule identifiers.
