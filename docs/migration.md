# Migrating a Colocated Portfolio

1. Copy `examples/catalog` to a new private Git repository.
2. Move `skills.lock.json`, `.skills-ignore.json`, `skills/`, `vendor/`, `upstream/`, `drafts/`, `project-decks/`, `shared-decks/`, and `agents/` into that Catalog.
3. Set `custom.repo` in the Inventory Lock to the Catalog repository identity.
4. Validate the boundary before changing daily commands:

   ```bash
   ./my-skills --catalog-dir /path/to/catalog status
   ./my-skills --catalog-dir /path/to/catalog list
   ./my-skills --catalog-dir /path/to/catalog ui
   ```

5. Set `MY_SKILLS_CATALOG_DIR` in the thin private launcher.
6. Run `make test` against the synthetic Catalog and exercise status/list/UI against the private Catalog.
7. Remove duplicated Engine code from the private Catalog only after both checks pass.

The Engine-root fallback preserves a colocated layout during migration, so each stage is reversible until the final cleanup.
