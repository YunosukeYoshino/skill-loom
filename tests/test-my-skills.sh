#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

source tests/lib/harness.sh
source tests/lib/fixtures.sh

# テスト本体は領域ごとに tests/cases/*.sh へ分かれている。ファイル名の数字は実行順。
# 領域を増やすときはファイルを 1 つ足すだけでよく、このファイルは編集しない。
for case_file in tests/cases/*.sh; do
  source "$case_file"
done

# ---- run ----

echo "=== my-skills CLI E2E tests ==="
echo ""

for case_name in "${CASES[@]}"; do
  "$case_name"
done

echo ""
echo "=== skill management script tests ==="
python3 tests/test_skill_management_scripts.py

echo ""
echo "${TOTAL} tests: ${PASS} passed, ${FAIL} failed"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
