#!/usr/bin/env python3
"""normalize-github-url — GitHub URL を owner/repo 形式に正規化する

使い方:
  python3 lib/normalize-github-url.py <url-or-owner/repo>

例:
  python3 lib/normalize-github-url.py https://github.com/better-auth/skills.git
  → better-auth/skills
"""

import re
import sys


def main():
    url = sys.argv[1]
    m = re.match(
        r"(?:https?://github\.com/|ssh://git@github\.com/|git@github\.com:)?"
        r"([\w.-]+/[\w.-]+?)(?:\.git)?/?$",
        url,
    )
    if not m:
        print(f"Error: Cannot parse GitHub URL: {url}", file=sys.stderr)
        sys.exit(1)
    print(m.group(1))


if __name__ == "__main__":
    main()
