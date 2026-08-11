#!/usr/bin/env python3
"""register-skill-lock — スキルを skills.lock.json の external セクションに登録する

使い方:
  python3 lib/register-skill-lock.py LOCK_FILE SKILL_NAME SOURCE SOURCE_URL SKILL_PATH

例:
  python3 lib/register-skill-lock.py skills.lock.json copywriting coreyhaines31/marketingskills \
    https://github.com/coreyhaines31/marketingskills.git skills/copywriting/SKILL.md
"""

import json
import os
import sys


def main():
    lock_path = sys.argv[1]
    skill_name = sys.argv[2]
    source = sys.argv[3]
    source_url = sys.argv[4]
    skill_path = sys.argv[5]

    with open(lock_path) as f:
        lock = json.load(f)

    if "external" not in lock:
        lock["external"] = {}

    lock["external"][skill_name] = {
        "source": source,
        "sourceUrl": source_url,
        "skillPath": skill_path,
    }

    tmp = lock_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(lock, f, indent=2)
        f.write("\n")
    os.replace(tmp, lock_path)
    print("  -> Registered in skills.lock.json")


if __name__ == "__main__":
    main()
