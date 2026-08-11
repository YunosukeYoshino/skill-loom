#!/usr/bin/env python3
"""check-skills — skills.lock.json とインストール済みスキルの整合性を確認する

リポジトリの skills.lock.json、~/.agents/skills/、~/.claude/skills/ の
3つの状態を照合し、過不足や不整合を検出する。

分類:
  - In lock (custom/vendor)                     → CUSTOM（自作・vendor スキル）
  - In lock (external)                          → EXTERNAL（外部管理）
  - Not in lock + ignore リストにある            → IGNORED（プラグイン管理、既知）
  - Not in lock + ignore リストにない            → UNMANAGED（未知、要確認）

使い方:
  python3 check-skills.py [LOCK_FILE] [AGENTS_DIR] [CLAUDE_DIR] [IGNORE_FILE]

  引数を省略した場合はリポジトリ root の skills.lock.json / .skills-ignore.json を使用。
"""

import json
import os
import sys
from collections import defaultdict
from pathlib import Path


def find_repo_root(start: Path) -> Path | None:
    current = start.resolve()
    for _ in range(12):
        if (current / "skills.lock.json").is_file():
            return current
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def repo_defaults() -> dict[str, Path]:
    selected_catalog = os.environ.get("MY_SKILLS_CATALOG_DIR")
    if selected_catalog:
        repo_root = Path(selected_catalog).expanduser().resolve()
    else:
        repo_root = find_repo_root(Path(__file__).resolve().parent)
        if repo_root is None:
            repo_root = Path.cwd()
    return {
        "lock_file": repo_root / "skills.lock.json",
        "agents_dir": Path.home() / ".agents" / "skills",
        "claude_dir": Path.home() / ".claude" / "skills",
        "ignore_file": repo_root / ".skills-ignore.json",
    }


DEFAULTS = repo_defaults()


def load_lock(lock_file: Path) -> dict:
    if not lock_file.exists():
        print(f"Error: {lock_file} not found", file=sys.stderr)
        sys.exit(1)
    with open(lock_file) as f:
        return json.load(f)


def load_ignore(ignore_file: Path) -> set[str]:
    if not ignore_file.exists():
        return set()
    with open(ignore_file) as f:
        return set(json.load(f).get("ignore", []))


def load_lock_ignored(lock: dict) -> set[str]:
    return set(lock.get("ignored", []))


def scan_dir(directory: Path, *, include_symlinks: bool = False) -> set[str]:
    if not directory.exists():
        return set()
    names = set()
    for p in directory.iterdir():
        if p.name.startswith("."):
            continue
        if p.is_dir() or (include_symlinks and p.is_symlink()):
            names.add(p.name)
    return names


def build_managed_skills(lock: dict) -> dict[str, dict[str, str]]:
    managed: dict[str, dict[str, str]] = {}
    custom_repo = lock.get("custom", {}).get("repo", "Catalog")

    for name in lock.get("custom", {}).get("skills", {}):
        managed[name] = {"kind": "custom", "source": custom_repo}

    for name, meta in lock.get("external", {}).items():
        managed[name] = {
            "kind": "external",
            "source": meta.get("source", "unknown"),
        }

    for name in lock.get("vendor", {}):
        managed[name] = {"kind": "vendor", "source": custom_repo}

    return managed


def classify(lock: dict, ignore_list: set[str], agents_installed: set[str], claude_installed: set[str]):
    managed = build_managed_skills(lock)
    lock_names = set(managed.keys())
    all_names = lock_names | agents_installed | claude_installed
    ignored_names = set(ignore_list) | load_lock_ignored(lock)

    custom = {}
    external = defaultdict(list)
    ignored = set()
    unmanaged_agents = set()
    unmanaged_claude = set()

    for name in sorted(all_names):
        in_lock = name in managed
        in_agents = name in agents_installed
        in_claude = name in claude_installed

        if in_lock:
            meta = managed[name]
            state = {"agents": in_agents, "claude": in_claude}
            if meta["kind"] in {"custom", "vendor"}:
                custom[name] = state
            else:
                external[meta["source"]].append({"name": name, **state})
        elif name in ignored_names:
            ignored.add(name)
        else:
            if in_agents:
                unmanaged_agents.add(name)
            if in_claude:
                unmanaged_claude.add(name)

    return custom, external, ignored, unmanaged_agents, unmanaged_claude


def print_results(custom, external, ignored, unmanaged_agents, unmanaged_claude):
    print("=== CUSTOM (Catalog) ===")
    issues_custom = 0
    for name, state in sorted(custom.items()):
        markers = []
        if not state["agents"]:
            markers.append("NO ~/.agents/skills/")
        if not state["claude"]:
            markers.append("NO ~/.claude/skills/")
        suffix = f"  !! {', '.join(markers)}" if markers else ""
        print(f"  {name}{suffix}")
        if markers:
            issues_custom += 1
    print(f"  ({len(custom)} skills, {issues_custom} issues)")
    print()

    print("=== EXTERNAL (npx skills managed) ===")
    issues_ext = 0
    for source, skills in sorted(external.items()):
        print(f"  {source} ({len(skills)})")
        for s in sorted(skills, key=lambda x: x["name"]):
            markers = []
            if not s["agents"]:
                markers.append("NO ~/.agents/skills/")
            if not s["claude"]:
                markers.append("NO ~/.claude/skills/")
            suffix = f"  !! {', '.join(markers)}" if markers else ""
            print(f"    {s['name']}{suffix}")
            if markers:
                issues_ext += 1
        print()
    ext_total = sum(len(v) for v in external.values())
    print(f"  ({ext_total} skills, {issues_ext} issues)")
    print()

    if ignored:
        print(f"=== IGNORED (plugin-managed, {len(ignored)}) ===")
        for name in sorted(ignored):
            print(f"  {name}")
        print()

    unmanaged_all = unmanaged_agents | unmanaged_claude
    if unmanaged_all:
        print(f"=== UNMANAGED ({len(unmanaged_all)}) ===")
        for name in sorted(unmanaged_all):
            where = []
            if name in unmanaged_agents:
                where.append("~/.agents/skills/")
            if name in unmanaged_claude:
                where.append("~/.claude/skills/")
            print(f"  {name}  ({', '.join(where)})")
        print()

    print("=== TOTALS ===")
    print(f"  Custom:    {len(custom)}")
    print(f"  External:  {ext_total}")
    print(f"  Ignored:   {len(ignored)}")
    print(f"  Unmanaged: {len(unmanaged_all)}")
    print(f"  Issues:    {issues_custom + issues_ext}")
    if not unmanaged_all and issues_custom + issues_ext == 0:
        print("  ALL CLEAN")
    print()


def main():
    lock_file = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULTS["lock_file"]
    agents_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULTS["agents_dir"]
    claude_dir = Path(sys.argv[3]) if len(sys.argv) > 3 else DEFAULTS["claude_dir"]
    ignore_file = Path(sys.argv[4]) if len(sys.argv) > 4 else DEFAULTS["ignore_file"]

    lock = load_lock(lock_file)
    ignore_list = load_ignore(ignore_file) | load_lock_ignored(lock)
    agents_installed = scan_dir(agents_dir)
    claude_installed = scan_dir(claude_dir, include_symlinks=True)

    custom, external, ignored, unmanaged_agents, unmanaged_claude = classify(
        lock, ignore_list, agents_installed, claude_installed
    )
    print_results(custom, external, ignored, unmanaged_agents, unmanaged_claude)


if __name__ == "__main__":
    main()
