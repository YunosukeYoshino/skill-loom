#!/usr/bin/env python3
"""restore-lock — skills.lock.json に基づいて外部スキルのインストールコマンドを生成する

外部スキルをソースごとにグループ化し、npx skills add コマンドのリストを
標準出力に1行ずつ出力する。restore-from-lock.sh からパイプで呼ばれる。

使い方:
  python3 restore-lock.py LOCK_FILE
"""

import json
import sys
from collections import defaultdict


def main():
    lock_file = sys.argv[1]
    with open(lock_file) as f:
        lock = json.load(f)

    by_source = defaultdict(list)
    for name, meta in lock.get("external", {}).items():
        source = meta.get("source")
        if not source:
            print(f"Warning: skipping external skill {name!r}: missing source", file=sys.stderr)
            continue
        install_name = meta.get("installSkill", name)
        by_source[source].append(install_name)

    for source, skills in sorted(by_source.items()):
        skill_args = " ".join(f"--skill {s}" for s in sorted(set(skills)))
        print(f"npx skills add {source} {skill_args} -g -a claude-code -a codex -a antigravity -y")


if __name__ == "__main__":
    main()
