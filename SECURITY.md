# Security Policy

## Supported versions

Security fixes are provided for the latest revision on `main` until versioned releases begin.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not open a public issue containing credentials, private Catalog data, or an exploitable path.

Include the affected revision, reproduction steps using a synthetic Catalog, expected impact, and whether the issue crosses the Catalog Root boundary. You should receive an acknowledgement within seven days.

## Security boundary

Skill Loom is a local-only management tool. The Web UI binds to localhost by default and has no authentication layer. Do not expose it to an untrusted network.

Catalog-relative Lock paths reject absolute paths, parent traversal, and symlink escapes. Projection removal uses recoverable Trash operations. See [docs/security-model.md](docs/security-model.md) for the complete model.
