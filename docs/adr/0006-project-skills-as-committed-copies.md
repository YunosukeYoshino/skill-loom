# 6. Project Skills as Committed Copies

Date: 2026-11-21

## Status

Accepted.

## Context

A developer opening a cloned repository needs to browse, update, remove, and install its skills without changing the global Projection. Collaborators must receive usable skills without access to the original developer's Catalog or home directory. A Project Deck is a reusable recipe, not a checkout or a deployment target.

## Decision

Register Projects by an existing absolute local path and a validated name. A Project Deck is optional. Keep the registry machine-local under `~/.agents/skill-projects/` (`MY_SKILLS_PROJECTS_DIR` overrides it); no machine-specific paths belong in the project manifest.

Copy skill trees into the project's `.agents/skills/<name>/`, with relative `.claude/skills/<name>` links. Codex and Antigravity use `.agents/skills` directly in `skills@1.7.6`; neither needs an additional project link. Copies and `.agents/skill-loom.json` are intended to be committed by the user. Never auto-commit in the Project repository.

The manifest records managed names, source kind, source version, and a SHA-256 tree hash. Source versions are the Catalog Git revision (marked `+dirty` if applicable), or the external skills CLI lock's tree hash/ref. A non-Git source without version metadata records `null`; the content hash remains the comparison baseline. Sources resolve from Inventory Catalog assets first; External Skills may fall back to global Active. Sync never installs into or mutates the global Projection.

Show all project skill directories, including unmanaged copies, names and descriptions. Explicit install copies an Inventory skill; update re-copies and can adopt an unmanaged Inventory match. Before overwriting drift or adopting unmanaged content, show a diff and require explicit confirmation against a revision token; stale previews are rejected. Explicit remove may delete unmanaged skills too, with a warning that committing the removal affects collaborators. Bulk sync never adopts or removes unmanaged skills, even with force.

A Project skill absent from Inventory can be explicitly imported as a Catalog Draft (`drafts/skills/imported/<name>/` by default, with a selectable category in the API/CLI). Preserve the Project copy and do not auto-promote or adopt it. Reject names already in Inventory or Drafts, unsafe paths, differing same-named project copies, and frontmatter names that differ from their directory. The existing Draft promotion flow then adds it to Inventory, after which a reviewed Project update can adopt it. Only the Catalog Draft is eligible for the existing Catalog auto-commit policy.

Optional deck sync resolves `extends`, without automatically unioning Core. It plans adds, updates, and removals of manifest-managed skills, skips unavailable sources and unmanaged conflicts, and preserves drift unless explicitly reviewed and forced. Dry-run does not write. Missing Project paths remain registered and visible, but only unregister is allowed until the directory returns.

Project paths and Catalog sources must stay within their respective boundaries. Do not follow nested skill symlinks, and never delete the target of a project skill symlink. Reject overlapping global runtime paths. Write metadata atomically through temporary files and rename; stage a complete skill copy before replacing the destination.

Status includes Git dirtiness under the skill directories and manifest; non-Git directories are supported. The UI reminds users to review their repository diff.

Global/project name collisions are agent-specific: [Claude Code](https://code.claude.com/docs/en/skills#where-skills-live) documents personal over project precedence. [Codex](https://developers.openai.com/codex/skills/) documents that same-named skills are not merged and both may appear in selectors. Show this information rather than promising a universal project override.

## Consequences

- A clone contains portable skill content, without symlinks into another machine's Catalog.
- Copies intentionally duplicate content; updates are explicit, reviewable repository changes.
- Inventory management and global Active/Archive remain independent from Project operations.
- Local modifications survive routine deck sync; overwrite approval is tied to the content actually reviewed.
- Machine-local registration must be repeated for each checkout. Unregister leaves all project files intact.
- Version metadata provides provenance, not automatic network update discovery; content hashes decide local source changes.
