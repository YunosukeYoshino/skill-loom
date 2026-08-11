# CLI サブコマンドと起動オプション

test_skill_loom_is_the_primary_launcher() {
  echo "Running test_skill_loom_is_the_primary_launcher..."
  local out compatibility_out

  if [ ! -x ./skill-loom ]; then
    fail "test_skill_loom_is_the_primary_launcher: ./skill-loom is not executable"
    return
  fi

  out=$(./skill-loom --help 2>&1)
  assert_contains "$out" "usage: skill-loom" \
    && pass "test_skill_loom_is_the_primary_launcher: canonical help uses skill-loom" \
    || fail "test_skill_loom_is_the_primary_launcher: output was $out"

  compatibility_out=$(./my-skills --help 2>&1)
  [ "$compatibility_out" = "$out" ] \
    && pass "test_skill_loom_is_the_primary_launcher: my-skills compatibility wrapper works" \
    || fail "test_skill_loom_is_the_primary_launcher: compatibility output differed"
}

test_list() {
  echo "Running test_list..."
  local out
  out=$(MY_SKILLS_CATALOG_DIR="$REPO_ROOT/examples/catalog" ./skill-loom list 2>&1)

  assert_contains "$out" "Project decks:" \
    && pass "test_list: has header" \
    || fail "test_list: missing header"

  assert_contains "$out" "example" \
    && pass "test_list: has example deck" \
    || fail "test_list: missing example deck"
}

test_status() {
  echo "Running test_status..."
  local out
  out=$(MY_SKILLS_CATALOG_DIR="$REPO_ROOT/examples/catalog" ./skill-loom status 2>&1)

  for field in active tracked ignored archive; do
    assert_matches "$out" "^${field}:" \
      && pass "test_status: has $field count" \
      || fail "test_status: missing $field count"
  done

  assert_matches "$out" "active:[[:space:]]+[0-9]+" \
    && pass "test_status: active is numeric" \
    || fail "test_status: active not numeric"
}

test_cli_catalog_dir_overrides_lock_file_override() {
  echo "Running test_cli_catalog_dir_overrides_lock_file_override..."
  local tmp_dir catalog_dir decoy_lock out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  catalog_dir="$tmp_dir/catalog"
  decoy_lock="$tmp_dir/decoy-lock.json"
  mkdir -p "$catalog_dir" "$tmp_dir/active" "$tmp_dir/archive"

  cat > "$catalog_dir/skills.lock.json" <<'JSON'
{"version":1,"custom":{"repo":"owner/catalog","skills":{"catalog-skill":{"repoPath":"skills/engineering/catalog-skill","category":"engineering"}}},"external":{},"vendor":{}}
JSON
  cat > "$decoy_lock" <<'JSON'
{"custom":{"skills":{"decoy-a":{},"decoy-b":{}}},"external":{}}
JSON

  out=$(MY_SKILLS_LOCK_FILE="$decoy_lock" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    ./skill-loom --catalog-dir "$catalog_dir" status 2>&1)

  assert_matches "$out" "^tracked:[[:space:]]+1$" \
    && pass "test_cli_catalog_dir_overrides_lock_file_override: selected Catalog Lock wins" \
    || fail "test_cli_catalog_dir_overrides_lock_file_override: output was $out"
}

test_catalog_env_reads_lock_and_ignore_from_catalog() {
  echo "Running test_catalog_env_reads_lock_and_ignore_from_catalog..."
  local tmp_dir catalog_dir out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  catalog_dir="$tmp_dir/catalog"
  mkdir -p "$catalog_dir" "$tmp_dir/active" "$tmp_dir/archive"

  cat > "$catalog_dir/skills.lock.json" <<'JSON'
{"version":1,"custom":{"repo":"owner/catalog","skills":{"catalog-skill":{"repoPath":"skills/engineering/catalog-skill","category":"engineering"}}},"external":{},"vendor":{}}
JSON
  cat > "$catalog_dir/.skills-ignore.json" <<'JSON'
{"ignore":["catalog-skill"]}
JSON

  out=$(MY_SKILLS_CATALOG_DIR="$catalog_dir" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    ./skill-loom status 2>&1)

  assert_matches "$out" "^tracked:[[:space:]]+0$" \
    && assert_matches "$out" "^ignored:[[:space:]]+1$" \
    && pass "test_catalog_env_reads_lock_and_ignore_from_catalog: Catalog data selected" \
    || fail "test_catalog_env_reads_lock_and_ignore_from_catalog: output was $out"
}

test_status_rejects_unsupported_catalog_lock() {
  echo "Running test_status_rejects_unsupported_catalog_lock..."
  local tmp_dir catalog_dir out rc
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  catalog_dir="$tmp_dir/catalog"
  mkdir -p "$catalog_dir" "$tmp_dir/active" "$tmp_dir/archive"
  printf '{"version":2,"custom":{"repo":"owner/catalog","skills":{}},"external":{},"vendor":{}}\n' \
    > "$catalog_dir/skills.lock.json"

  if out=$(MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    ./skill-loom --catalog-dir "$catalog_dir" status 2>&1); then
    rc=0
  else
    rc=$?
  fi

  [ "$rc" -ne 0 ] \
    && assert_contains "$out" "$catalog_dir/skills.lock.json.version: unsupported version 2; expected 1" \
    && pass "test_status_rejects_unsupported_catalog_lock: actionable error" \
    || fail "test_status_rejects_unsupported_catalog_lock: rc=$rc output=$out"
}

test_synthetic_catalog_smoke() {
  echo "Running test_synthetic_catalog_smoke..."
  local tmp_dir catalog_dir status_out list_out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  catalog_dir="$REPO_ROOT/examples/catalog"
  mkdir -p "$tmp_dir/active" "$tmp_dir/archive"

  status_out=$(MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    ./skill-loom --catalog-dir "$catalog_dir" status 2>&1)
  list_out=$(./skill-loom --catalog-dir "$catalog_dir" list 2>&1)

  assert_matches "$status_out" '^tracked:[[:space:]]+0$' \
    && assert_contains "$list_out" "example" \
    && pass "test_synthetic_catalog_smoke: empty Inventory and example Deck work" \
    || fail "test_synthetic_catalog_smoke: status=$status_out list=$list_out"
}

test_cli_catalog_dir_reads_catalog_decks() {
  echo "Running test_cli_catalog_dir_reads_catalog_decks..."
  local tmp_dir catalog_dir out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  catalog_dir="$tmp_dir/catalog"
  mkdir -p "$catalog_dir/project-decks" "$catalog_dir/shared-decks"

  cat > "$catalog_dir/shared-decks/core.json" <<'JSON'
{"name":"core","skills":["core-skill"]}
JSON
  cat > "$catalog_dir/project-decks/catalog-only.json" <<'JSON'
{"name":"catalog-only","extends":["core"],"skills":["project-skill"]}
JSON

  out=$(./skill-loom --catalog-dir "$catalog_dir" list 2>&1)

  assert_contains "$out" "catalog-only" \
    && assert_matches "$out" "catalog-only[[:space:]]+2" \
    && ! assert_contains "$out" "frontend" \
    && pass "test_cli_catalog_dir_reads_catalog_decks: Catalog Decks selected" \
    || fail "test_cli_catalog_dir_reads_catalog_decks: output was $out"
}

test_all_preview() {
  echo "Running test_all_preview..."
  local out
  out=$(MY_SKILLS_CATALOG_DIR="$REPO_ROOT/examples/catalog" ./skill-loom all 2>&1)

  assert_matches "$out" "active:" \
    && pass "test_all_preview: has active count" \
    || fail "test_all_preview: missing active count"

  assert_matches "$out" "target:" \
    && pass "test_all_preview: has target count" \
    || fail "test_all_preview: missing target count"

  assert_matches "$out" "(move to archive|restore from archive|install missing)" \
    && pass "test_all_preview: has delta section" \
    || fail "test_all_preview: missing delta section"
}

test_ui_help() {
  echo "Running test_ui_help..."
  local out
  out=$(./skill-loom ui --help 2>&1)
  local rc=$?

  [ "$rc" -eq 0 ] \
    && pass "test_ui_help: exit code 0" \
    || fail "test_ui_help: exit code $rc"

  assert_contains "$out" "--port" \
    && pass "test_ui_help: has --port" \
    || fail "test_ui_help: missing --port"

  assert_contains "$out" "--host" \
    && pass "test_ui_help: has --host" \
    || fail "test_ui_help: missing --host"
}

test_install_deck_help() {
  echo "Running test_install_deck_help..."
  local out
  out=$(./skill-loom --help 2>&1)

  assert_contains "$out" "install-deck" \
    && pass "test_install_deck_help: has install-deck command" \
    || fail "test_install_deck_help: missing install-deck command"
}

test_ui_starts_specific_port() {
  echo "Running test_ui_starts_specific_port..."
  local port=18799
  MY_SKILLS_CATALOG_DIR="$REPO_ROOT/examples/catalog" ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/" 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_ui_starts_specific_port: HTTP 200 on port $port" \
      || fail "test_ui_starts_specific_port: got HTTP $http_code"
  else
    fail "test_ui_starts_specific_port: server did not start"
  fi
}

test_no_script_shells_out_to_deleted_python_cli() {
  echo "Running test_no_script_shells_out_to_deleted_python_cli..."
  # bin/my-skills.py は #75 で削除された。残存スクリプトが削除済み CLI を呼び続けると、
  # skills-add の install が終わったあとで exit 2 で落ちる（実例: gh-stack 取り込み）。
  # CLI の入口は ./skill-loom (TypeScript) なので、実行参照が残っていないか固定する。
  local hits
  hits=$(rg -n 'bin/my-skills\.py' \
    .agents/skills/*/scripts/ skills/*/*/scripts/ drafts/skills/*/scripts/ 2>/dev/null || true)
  if [ -z "$hits" ]; then
    pass "test_no_script_shells_out_to_deleted_python_cli: no stale bin/my-skills.py refs"
  else
    fail "test_no_script_shells_out_to_deleted_python_cli: stale refs found"
    echo "$hits"
  fi
}

register_cases \
  test_skill_loom_is_the_primary_launcher \
  test_list \
  test_status \
  test_cli_catalog_dir_overrides_lock_file_override \
  test_catalog_env_reads_lock_and_ignore_from_catalog \
  test_status_rejects_unsupported_catalog_lock \
  test_synthetic_catalog_smoke \
  test_cli_catalog_dir_reads_catalog_decks \
  test_all_preview \
  test_ui_help \
  test_install_deck_help \
  test_ui_starts_specific_port \
  test_no_script_shells_out_to_deleted_python_cli
