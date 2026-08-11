# テストハーネス: カウンタ、サンドボックス、アサーション、ケース登録。

# SPA API mode: serve built frontend, no Vite in tests
export MY_SKILLS_VITE=0
if [ ! -f app/frontend/dist/index.html ]; then
  echo "Building frontend for UI tests..."
  (cd app/frontend && bun run build)
fi

PASS=0
FAIL=0
TOTAL=0
UI_PIDS=()
TMP_DIRS=()
CASES=()

# Keep the real ~/.claude, ~/.gemini and skills CLI lock out of reach: Apply now
# writes to all three, so an unscoped test would delete the developer's symlinks.
TEST_SANDBOX=$(mktemp -d)
TMP_DIRS+=("$TEST_SANDBOX")
mkdir -p "$TEST_SANDBOX/trash"
cat > "$TEST_SANDBOX/trash-bin" <<'SH'
#!/bin/bash
set -euo pipefail
trash_root="${MY_SKILLS_TEST_TRASH_DIR:?}"
for path in "$@"; do
  item_dir=$(mktemp -d "$trash_root/item.XXXXXX")
  mv -- "$path" "$item_dir/$(basename "$path")"
done
SH
chmod +x "$TEST_SANDBOX/trash-bin"
export MY_SKILLS_TRASH_BIN="$TEST_SANDBOX/trash-bin"
export MY_SKILLS_TEST_TRASH_DIR="$TEST_SANDBOX/trash"
export MY_SKILLS_CLAUDE_SKILLS_DIR="$TEST_SANDBOX/claude-skills"
export MY_SKILLS_GEMINI_SKILLS_DIR="$TEST_SANDBOX/gemini-skills"
export MY_SKILLS_GLOBAL_LOCK_FILE="$TEST_SANDBOX/.skill-lock.json"

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "  FAIL: $1 ${2:-}"; }

# 配列が空のまま `"${arr[@]}"` を展開すると set -u で落ちる。空配列でも安全な形にして
# おかないと、本来の失敗がこの unbound variable に化けて原因が見えなくなる。
cleanup() {
  for pid in ${UI_PIDS[@]+"${UI_PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  for dir in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do
    [ -e "$dir" ] && /usr/bin/trash "$dir" 2>/dev/null || true
  done
}
trap cleanup EXIT

# 各 tests/cases/*.sh が末尾で自分のケースを実行順に登録する。
register_cases() { CASES+=("$@"); }

# ---- helpers ----

assert_contains() {
  local haystack="$1" needle="$2"
  grep -qF -- "$needle" <<< "$haystack"
}

assert_matches() {
  local haystack="$1" pattern="$2"
  grep -qE "$pattern" <<< "$haystack"
}

wait_for_port() {
  local port="$1" attempts=0
  while [ $attempts -lt 20 ]; do
    if curl -s -o /dev/null "http://localhost:${port}/" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
    attempts=$((attempts + 1))
  done
  return 1
}
