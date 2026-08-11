# Example Catalog

Copy this directory into a separate Git repository, set `custom.repo` in
`skills.lock.json`, then select it explicitly:

```bash
./skill-loom --catalog-dir /path/to/catalog status
./skill-loom --catalog-dir /path/to/catalog list
```

The Catalog owns Inventory data (`skills.lock.json`, `.skills-ignore.json`),
Project and Shared Decks, Custom/Vendor/Upstream Skills, Drafts, and Agent
definitions. The Engine checkout remains reusable and contains no private
Catalog data.
