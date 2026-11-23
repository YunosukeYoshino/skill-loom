# plugin export の CLI seam
#
# Catalog 側の Deck / Inventory / skill 本体を一時領域に置き、`plugin export` が
# パッケージを書き出す様子をファイルの実在で固定する。Engine checkout の実
# Catalog には触れない。

setup_plugin_fixture() {
  local tmp_dir="$1"
  mkdir -p "$tmp_dir/active" "$tmp_dir/archive" "$tmp_dir/catalog/project-decks" \
    "$tmp_dir/catalog/shared-decks" "$tmp_dir/catalog/skills/fixture/alpha" \
    "$tmp_dir/out"

  printf -- '---\nname: alpha\ndescription: alpha fixture\n---\n' \
    > "$tmp_dir/catalog/skills/fixture/alpha/SKILL.md"

  cat > "$tmp_dir/catalog/skills.lock.json" <<'JSON'
{
  "version": 1,
  "custom": {
    "repo": "owner/catalog",
    "skills": {
      "alpha": {"repoPath": "skills/fixture/alpha", "category": "fixture"}
    }
  },
  "external": {
    "ghost": {
      "source": "acme/pack",
      "sourceUrl": "https://github.com/acme/pack.git",
      "skillPath": "skills/ghost/SKILL.md"
    }
  },
  "vendor": {}
}
JSON

  cat > "$tmp_dir/catalog/project-decks/pack.json" <<'JSON'
{"name": "pack", "description": "Pack deck", "skills": ["alpha"]}
JSON
  cat > "$tmp_dir/catalog/project-decks/broken.json" <<'JSON'
{"name": "broken", "skills": ["alpha", "ghost", "unknown"]}
JSON
  cat > "$tmp_dir/catalog/shared-decks/core.json" <<'JSON'
{"name": "core", "skills": []}
JSON
}

run_plugin_cli() {
  local tmp_dir="$1"
  shift
  MY_SKILLS_CATALOG_DIR="$tmp_dir/catalog" \
    MY_SKILLS_LOCK_FILE="$tmp_dir/catalog/skills.lock.json" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_PROJECT_DECKS_DIR="$tmp_dir/catalog/project-decks" \
    ./skill-loom "$@" > "$tmp_dir/cli-stdout.txt" 2> "$tmp_dir/cli-stderr.txt" \
    && echo 0 || echo $?
}

test_plugin_export_writes_package() {
  echo "Running test_plugin_export_writes_package..."
  local tmp_dir code
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_plugin_fixture "$tmp_dir"

  code=$(run_plugin_cli "$tmp_dir" plugin export pack --out "$tmp_dir/out")

  [ "$code" = "0" ] \
    && pass "test_plugin_export_writes_package: exits 0" \
    || fail "test_plugin_export_writes_package: exit $code, stderr was $(cat "$tmp_dir/cli-stderr.txt")"

  for path in \
    "plugin.json" \
    ".claude-plugin/plugin.json" \
    ".claude-plugin/marketplace.json" \
    ".cursor-plugin/plugin.json" \
    ".cursor-plugin/marketplace.json" \
    ".codex-plugin/plugin.json" \
    "skills/alpha/SKILL.md"; do
    [ -f "$tmp_dir/out/$path" ] \
      && pass "test_plugin_export_writes_package: wrote $path" \
      || fail "test_plugin_export_writes_package: missing $path"
  done

  grep -q 'agent-plugins.org/schemas' "$tmp_dir/out/plugin.json" \
    && pass "test_plugin_export_writes_package: root manifest declares the Agent Plugins schema" \
    || fail "test_plugin_export_writes_package: root manifest missing schema"
}

test_plugin_export_unresolved_exits_2() {
  echo "Running test_plugin_export_unresolved_exits_2..."
  local tmp_dir code
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_plugin_fixture "$tmp_dir"

  code=$(run_plugin_cli "$tmp_dir" plugin export broken --out "$tmp_dir/out")

  [ "$code" = "2" ] \
    && pass "test_plugin_export_unresolved_exits_2: exits 2" \
    || fail "test_plugin_export_unresolved_exits_2: exit $code"

  assert_contains "$(cat "$tmp_dir/cli-stderr.txt")" "ghost, unknown" \
    && pass "test_plugin_export_unresolved_exits_2: lists unresolved names" \
    || fail "test_plugin_export_unresolved_exits_2: stderr was $(cat "$tmp_dir/cli-stderr.txt")"

  [ ! -e "$tmp_dir/out/plugin.json" ] \
    && pass "test_plugin_export_unresolved_exits_2: no partial package" \
    || fail "test_plugin_export_unresolved_exits_2: package was still written"
}

test_plugin_export_json_mode() {
  echo "Running test_plugin_export_json_mode..."
  local tmp_dir code
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_plugin_fixture "$tmp_dir"

  code=$(run_plugin_cli "$tmp_dir" --json plugin export pack --out "$tmp_dir/out")

  [ "$code" = "0" ] \
    && pass "test_plugin_export_json_mode: exits 0" \
    || fail "test_plugin_export_json_mode: exit $code"

  assert_contains "$(cat "$tmp_dir/cli-stdout.txt")" '"deckKind":"project"' \
    && pass "test_plugin_export_json_mode: reports deck kind" \
    || fail "test_plugin_export_json_mode: stdout was $(cat "$tmp_dir/cli-stdout.txt")"
}

register_cases \
  test_plugin_export_writes_package \
  test_plugin_export_unresolved_exits_2 \
  test_plugin_export_json_mode
