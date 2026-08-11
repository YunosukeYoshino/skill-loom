#!/usr/bin/env python3
"""lock-repo — skills.lock.json からカスタムリポジトリ名を取得する

使い方:
  python3 lib/lock-repo.py LOCK_FILE
"""

import json
import sys


def main():
    with open(sys.argv[1]) as f:
        lock = json.load(f)
    print(lock["custom"]["repo"])


if __name__ == "__main__":
    main()
