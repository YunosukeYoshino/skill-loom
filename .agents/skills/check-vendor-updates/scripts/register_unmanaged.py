#!/usr/bin/env python3
"""Register unmanaged skills into skills.lock.json.

Discovers installed skills that are not tracked in lock.json (external, custom,
or ignored) and adds them to the appropriate section.

Usage:
  # Dry run — show what would be registered, don't write
  python3 scripts/register_unmanaged.py --dry-run

  # Register all unmanaged skills (auto-detects custom vs external)
  python3 scripts/register_unmanaged.py

  # Register specific skills only
  python3 scripts/register_unmanaged.py --skills simplify,technical-research

  # Force custom registration (skips global-lock source lookup)
  python3 scripts/register_unmanaged.py --mode custom --skills my-local-skill

  # Force external registration
  python3 scripts/register_unmanaged.py --mode external --skills api-and-interface-design
"""

import argparse
import json
import os
import sys
from collections import OrderedDict
from pathlib import Path

REPO_ROOT_ENV = "REPO_ROOT"
CATALOG_ROOT_ENV = "MY_SKILLS_CATALOG_DIR"
GLOBAL_LOCK_PATH = Path.home() / ".agents" / ".skill-lock.json"
GLOBAL_SKILLS_DIR = Path.home() / ".agents" / "skills"
LOCAL_SKILLS_DIR = Path(".agents") / "skills"
LOCAL_SKILLS_DIR_STR = ".agents/skills"

# Known category mapping for common skill names
CATEGORY_HINTS = {
    # engineering
    "technical-research": "research",
    "api-and-interface-design": "engineering",
    "software-engineering-principles": "engineering",
    "context-engineering": "engineering",
    "source-driven-development": "engineering",
    "tdd-twada": "engineering",
    "vercel-react-best-practices": "engineering",
    "hono": "engineering",
    "prisma-cli": "engineering",
    "prisma-client-api": "engineering",
    "prisma-database-setup": "engineering",
    "prisma-driver-adapter-implementation": "engineering",
    "prisma-postgres": "engineering",
    "postgres-best-practices": "engineering",
    "react-router-framework-mode": "engineering",
    "turso-db": "engineering",
    # design
    "frontend-ui-engineering": "design",
    "high-end-visual-design": "design",
    "minimalist-ui": "design",
    "baseline-ui": "design",
    "shadcn": "design",
    "make-interfaces-feel-better": "design",
    "ui-ux-pro-max": "design",
    "web-design-guidelines": "design",
    # security
    "security-and-hardening": "engineering",
    "fixing-accessibility": "design",
    "fixing-metadata": "design",
    "fixing-motion-performance": "engineering",
    # performance
    "performance-optimization": "engineering",
    # research
    "gemini-search": "research",
    "use-tinyfish": "research",
    "idea-refine": "research",
    # workflow
    "git": "workflow",
    "new-skill": "workflow",
    "update-skill": "workflow",
    "vendor-fork": "workflow",
    "skills-add": "workflow",
    "symphony-setup": "workflow",
    "symphony-spec-writer": "workflow",
    "symphony-delivery-flow": "workflow",
    "check-vendor-updates": "workflow",
    # devops
    "wp-env-cli": "devops",
    "portless": "devops",
    "bitwarden-dev-secrets": "devops",
    "docker-cleanup": "devops",
    # external-tools
    "obsidian-markdown": "external-tools",
    "openai-docs": "external-tools",
    "browser-use": "external-tools",
    "agent-browser": "external-tools",
    "notion": "external-tools",
    "electron": "external-tools",
    # marketing
    "copywriting": "marketing",
    "lead-magnets": "marketing",
    "marketing-psychology": "marketing",
    "programmatic-seo": "marketing",
    "sales-enablement": "marketing",
    "revops": "marketing",
    "page-cro": "marketing",
    "site-architecture": "marketing",
}


def load_json(path: Path) -> dict | list | None:
    """Load JSON file, return None if not found."""
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def save_json(path: Path, data: dict) -> None:
    """Save JSON to file with sorted keys and trailing newline."""
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def get_repo_root() -> Path:
    """Get the selected Catalog from env vars or the current Git repository."""
    env = os.environ.get(CATALOG_ROOT_ENV) or os.environ.get(REPO_ROOT_ENV)
    if env:
        return Path(env).expanduser().resolve()
    import subprocess

    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=True,
    )
    return Path(result.stdout.strip())


def get_managed_sets(lock: dict) -> tuple[set, set, set, set]:
    """Return (external, custom, vendor, ignored) name sets from lock.json."""
    external = set(lock.get("external", {}).keys())
    custom = set(lock.get("custom", {}).get("skills", {}).keys())
    vendor = set(lock.get("vendor", {}).keys())
    lock_ignored = set(lock.get("ignored", []))
    return external, custom, vendor, lock_ignored


def get_file_ignored(repo_root: Path) -> set:
    """Read .skills-ignore.json if it exists."""
    ignore_path = repo_root / ".skills-ignore.json"
    data = load_json(ignore_path)
    if data and isinstance(data, dict):
        return set(data.get("ignore", []))
    return set()


def get_installed_skills() -> set:
    """List installed skill directory names from ~/.agents/skills/."""
    if not GLOBAL_SKILLS_DIR.is_dir():
        return set()
    return {d.name for d in GLOBAL_SKILLS_DIR.iterdir() if d.is_dir() and d.name != ".system"}


def get_local_skill_dirs(repo_root: Path) -> set:
    """List skill dirs in .agents/skills/ within the repo."""
    local_dir = repo_root / LOCAL_SKILLS_DIR
    if not local_dir.is_dir():
        return set()
    return {d.name for d in local_dir.iterdir() if d.is_dir()}


def get_global_lock_skills() -> dict:
    """Load ~/.agents/.skill-lock.json skills section."""
    data = load_json(GLOBAL_LOCK_PATH)
    if data and isinstance(data, dict):
        return data.get("skills", {})
    return {}


def is_custom_skill(skill_name: str, repo_root: Path, global_lock: dict, custom_repo: str) -> bool:
    """Determine if a skill is a custom (in-repo) skill.

    Checks in order:
    1. Exists in local .agents/skills/ directory within the repo
    2. Global lock source points to the selected Catalog's custom repo
    3. NOT in global lock at all → likely manually installed custom skill
    """
    # Check local repo .agents/skills/
    local_skill_dir = repo_root / LOCAL_SKILLS_DIR / skill_name
    if local_skill_dir.is_dir():
        return True

    # Check global lock source
    skill_info = global_lock.get(skill_name, {})
    source = skill_info.get("source", "")
    if custom_repo and source.startswith(custom_repo):
        return True

    # Skill without global lock metadata is not automatically custom.
    # Let auto mode try external registration (or skip if source is unknown).
    return False


def infer_category(skill_name: str) -> str:
    """Infer category from skill name or known hints."""
    if skill_name in CATEGORY_HINTS:
        return CATEGORY_HINTS[skill_name]
    return "engineering"  # sensible default


def infer_repo_path(skill_name: str, category: str) -> str:
    """Infer repoPath from skill name and category."""
    return f"skills/{category}/{skill_name}"


def build_custom_entry(skill_name: str, repo_root: Path, global_lock: dict) -> dict | None:
    """Build a custom.skills entry for a skill."""
    category = infer_category(skill_name)
    repo_path = infer_repo_path(skill_name, category)

    actual_path = repo_root / repo_path / "SKILL.md"
    if actual_path.exists():
        return {"repoPath": repo_path, "category": category}

    alt_path = repo_root / LOCAL_SKILLS_DIR / skill_name
    if alt_path.is_dir() and (alt_path / "SKILL.md").exists():
        return {"repoPath": f"{LOCAL_SKILLS_DIR_STR}/{skill_name}", "category": category}

    return None


def build_external_entry(skill_name: str, global_lock: dict) -> dict | None:
    """Build an external entry from global lock data."""
    info = global_lock.get(skill_name)
    if not info:
        return None

    entry = {}
    for key in ("source", "sourceUrl", "skillPath"):
        if key in info:
            entry[key] = info[key]

    # localRepoPath/category are optional, skip unless present
    for key in ("localRepoPath", "category"):
        if key in info:
            entry[key] = info[key]

    # Minimum required fields
    if "source" not in entry or "skillPath" not in entry:
        return None

    return entry


def register_skills(
    lock: dict,
    skills_to_register: dict[str, dict],
    mode: str,
) -> dict:
    """Register skills into lock.json and return mutations made.

    Args:
        lock: Current lock.json data
        skills_to_register: {skill_name: entry_data} to register
        mode: "custom" or "external"

    Returns:
        Dict with registration results
    """
    mutations = {"added": [], "skipped": []}

    if mode == "custom":
        section = lock.setdefault("custom", {}).setdefault("skills", {})
    else:
        section = lock.setdefault("external", {})

    for name, entry in skills_to_register.items():
        if name in section:
            mutations["skipped"].append({"name": name, "reason": "already_registered"})
            continue

        section[name] = entry
        mutations["added"].append({"name": name, "entry": entry})

    # Sort the section keys alphabetically
    if mode == "external":
        lock["external"] = OrderedDict(sorted(lock["external"].items()))
    elif mode == "custom":
        lock["custom"]["skills"] = OrderedDict(sorted(lock["custom"]["skills"].items()))

    return mutations


def main():
    parser = argparse.ArgumentParser(description="Register unmanaged skills into skills.lock.json")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be registered without writing",
    )
    parser.add_argument(
        "--skills",
        type=str,
        default=None,
        help="Comma-separated list of specific skills to register",
    )
    parser.add_argument(
        "--mode",
        choices=["auto", "custom", "external"],
        default="auto",
        help="Registration mode: auto (detect), custom, or external",
    )
    args = parser.parse_args()

    repo_root = get_repo_root()
    lock_path = repo_root / "skills.lock.json"
    lock = load_json(lock_path)
    if lock is None or not isinstance(lock, dict):
        print(f"Error: {lock_path} not found or invalid", file=sys.stderr)
        sys.exit(1)

    external, custom, vendor, lock_ignored = get_managed_sets(lock)
    custom_repo = lock.get("custom", {}).get("repo", "")
    file_ignored = get_file_ignored(repo_root)
    ignored = lock_ignored | file_ignored
    managed = external | custom | vendor

    installed = get_installed_skills()
    unmanaged = installed - managed - ignored

    # Filter by --skills if specified
    if args.skills:
        target_skills = set(args.skills.split(","))
        unmanaged &= target_skills
        if unmanaged != target_skills:
            not_found = target_skills - unmanaged
            already_managed = target_skills & managed
            if already_managed:
                print(f"⚠️  Already managed (skipped): {', '.join(sorted(already_managed))}")
            not_existing = not_found - already_managed
            if not_existing:
                print(f"⚠️  Not found in installed skills: {', '.join(sorted(not_existing))}")

    if not unmanaged:
        print("✅ No unmanaged skills to register")
        return

    global_lock = get_global_lock_skills()
    _local_skills = get_local_skill_dirs(repo_root)  # noqa: F841

    # Classify unmanaged skills
    custom_skills = {}
    external_skills = {}

    for name in sorted(unmanaged):
        if args.mode == "custom":
            is_custom = True
        elif args.mode == "external":
            is_custom = False
        else:  # auto
            is_custom = is_custom_skill(name, repo_root, global_lock, custom_repo)

        if is_custom:
            entry = build_custom_entry(name, repo_root, global_lock)
            if entry is None:
                print(f"⚠️  Cannot locate repo source for custom skill '{name}' — skipping")
                continue
            custom_skills[name] = entry
        else:
            entry = build_external_entry(name, global_lock)
            if entry is None:
                print(f"⚠️  Cannot determine source for '{name}' — skipping")
                print("   Register manually: /skills-add <owner/repo>")
                continue
            external_skills[name] = entry

    # Summary
    print(f"\n📋 Registration plan ({'dry run' if args.dry_run else 'live'}):")
    if custom_skills:
        print(f"\n🏠 → custom.skills ({len(custom_skills)} 件):")
        for name, entry in custom_skills.items():
            print(f"  + {name}: {json.dumps(entry)}")
    if external_skills:
        print(f"\n📦 → external ({len(external_skills)} 件):")
        for name, entry in external_skills.items():
            print(f"  + {name}: {entry.get('source', '?')}")

    if args.dry_run:
        print("\n🔒 Dry run — no changes written")
        return

    # Register
    results = {}

    if custom_skills:
        result = register_skills(lock, custom_skills, "custom")
        results["custom"] = result

    if external_skills:
        result = register_skills(lock, external_skills, "external")
        results["external"] = result

    # Write back
    save_json(lock_path, lock)
    print(f"\n✅ Updated {lock_path}")

    # Report
    for mode, result in results.items():
        added = len(result["added"])
        skipped = len(result["skipped"])
        print(f"  {mode}: {added} added, {skipped} skipped")


if __name__ == "__main__":
    main()
