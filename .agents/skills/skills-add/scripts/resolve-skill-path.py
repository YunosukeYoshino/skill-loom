#!/usr/bin/env python3
"""resolve-skill-path — GitHub リポジトリツリーから SKILL.md の name を照合し skillPath を解決する

環境変数:
  TREE_FILE    — リポジトリツリーJSONのパス
  SKILL_NAME   — 検索するスキル名
  OWNER_REPO   — owner/repo 形式のリポジトリ指定

使い方:
  TREE_FILE=/tmp/tree.json SKILL_NAME=copywriting OWNER_REPO=coreyhaines31/marketingskills \
    python3 lib/resolve-skill-path.py
"""

import base64
import json
import os
import subprocess
import sys


def main():
    tree_file = os.environ["TREE_FILE"]
    skill_name = os.environ["SKILL_NAME"]
    owner_repo = os.environ["OWNER_REPO"]

    tree = json.loads(open(tree_file).read())

    skill_md_paths = [
        item["path"]
        for item in tree.get("tree", [])
        if item["path"].endswith("SKILL.md") and item.get("type") == "blob"
    ]

    for path in skill_md_paths:
        try:
            result = subprocess.run(
                ["gh", "api", f"repos/{owner_repo}/contents/{path}"],
                capture_output=True,
                text=True,
                check=True,
                timeout=15,
            )
            content_json = json.loads(result.stdout)
            raw = base64.b64decode(content_json.get("content", "")).decode("utf-8")
            in_fm = False
            for line in raw.splitlines():
                stripped = line.strip()
                if stripped == "---":
                    if not in_fm:
                        in_fm = True
                    else:
                        break
                elif in_fm and stripped.startswith("name:"):
                    name = stripped.split(":", 1)[1].strip().strip("\"'")
                    if name == skill_name:
                        print(path)
                        sys.exit(0)
        except Exception:
            continue

    sys.exit(1)


if __name__ == "__main__":
    main()
