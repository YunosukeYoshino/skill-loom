# Project Deck と Drafts の HTTP seam
#
# ここは白箱テストではなく、HTTP 越しに振る舞いを固定する層。ADR 0005 の
# 「Project Deck の Apply では Core Deck を自動 union する / merge では union しない」を
# 実ファイルの移動結果として検証するのが主目的。
#
# Core Deck (shared-decks/core.json) は環境変数で差し替えられないため、フィクスチャは
# 実物の core deck を読み、その skill を archive 側に置いた状態から始める。
# Apply で archive -> active に移れば「自動 union された」ことの証明になる。

# core deck の skill のうち .agents/skills 配下と名前が衝突するものは
# hidden_global_skills に落ちて投影対象にならないので、ignore ファイル側へ寄せる。
setup_deck_fixture() {
  local tmp_dir="$1"

  mkdir -p "$tmp_dir/active" "$tmp_dir/archive" "$tmp_dir/claude-skills" \
    "$tmp_dir/gemini-skills" "$tmp_dir/project-decks" "$tmp_dir/shared-decks"

  make_skill() {
    local base="$1" name="$2"
    mkdir -p "$tmp_dir/$base/$name"
    printf -- '---\nname: %s\ndescription: %s fixture\n---\n' "$name" "$name" > "$tmp_dir/$base/$name/SKILL.md"
  }

  for name in alpha beta; do
    make_skill active "$name"
  done

  # core deck の skill のうち .agents/skills 配下と衝突するものは hidden 扱い
  hidden_core=""
  visible_core="core-fixture"
  if [ -d ".agents/skills/core-fixture" ]; then
    hidden_core="core-fixture"
    visible_core=""
  fi
  if [ -n "$visible_core" ]; then
    make_skill archive "$visible_core"
  fi

  managed="alpha beta"
  [ -n "$visible_core" ] && managed="$managed $visible_core"

  {
    echo "{"
    echo "  \"version\": 1,"
    echo "  \"custom\": {"
    echo "    \"repo\": \"owner/catalog\","
    echo "    \"skills\": {"
    first=true
    for name in $managed; do
      [ "$first" = true ] || echo ","
      first=false
      printf '      "%s": {"repoPath": "skills/fixture/%s", "category": "fixture"}' "$name" "$name"
    done
    echo ""
    echo "    }"
    echo "  },"
    echo "  \"external\": {},"
    echo "  \"vendor\": {}"
    echo "}"
  } > "$tmp_dir/skills.lock.json"

  {
    echo "{"
    echo "  \"version\": 3,"
    echo "  \"dismissed\": [],"
    echo "  \"skills\": {"
    first=true
    for name in $managed; do
      [ "$first" = true ] || echo ","
      first=false
      printf '    "%s": {"source": "owner/repo", "installedAt": "2026-01-01T00:00:00.000Z"}' "$name"
    done
    echo ""
    echo "  }"
    echo "}"
  } > "$tmp_dir/.skill-lock.json"

  printf '{"ignore": ["%s"]}' "$hidden_core" > "$tmp_dir/skills-ignore.json"

  {
    echo '{'
    echo '  "name": "e2e-deck",'
    echo '  "description": "E2E fixture deck",'
    echo '  "skills": ["alpha"]'
    echo '}'
  } > "$tmp_dir/project-decks/e2e-deck.json"

  {
    echo '{'
    echo '  "name": "core",'
    echo '  "skills": ["core-fixture"]'
    echo '}'
    echo ""
  } > "$tmp_dir/shared-decks/core.json"

  for name in alpha beta; do
    ln -s "$tmp_dir/active/$name" "$tmp_dir/claude-skills/$name"
    ln -s "$tmp_dir/active/$name" "$tmp_dir/gemini-skills/$name"
  done

  # apply 側の期待値: core deck ∪ {alpha}。merge 側は active の {alpha, beta} のまま。
  printf '%s' "$visible_core" > "$tmp_dir/core-sample"
  printf '2' > "$tmp_dir/apply-target-count"

}

# ~/.claude や実 lock を巻き込まないよう、書き込み先をすべて tmp_dir へ寄せて起動する。
# MY_SKILLS_AUTO_COMMIT=0 は drafts promote がリポジトリを commit しないようにするため。
start_deck_ui() {
  local tmp_dir="$1" port="$2"
  local catalog_args=()
  if [ "$#" -ge 3 ]; then
    catalog_args=(--catalog-dir "$3")
  fi
  MY_SKILLS_LOCK_FILE="$tmp_dir/skills.lock.json" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" \
    MY_SKILLS_PROJECT_DECKS_DIR="$tmp_dir/project-decks" \
  MY_SKILLS_IGNORE_FILE="$tmp_dir/skills-ignore.json" \
    MY_SKILLS_CATALOG_DIR="$tmp_dir" \
    MY_SKILLS_AUTO_COMMIT=0 \
    ./skill-loom ui ${catalog_args[@]+"${catalog_args[@]}"} --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2
}

deck_get() {
  local port="$1" path="$2"
  curl -s "http://localhost:${port}${path}" 2>/dev/null || true
}

deck_post() {
  local tmp_dir="$1" port="$2" path="$3" body="$4"
  curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
    -X POST "http://localhost:${port}${path}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null || echo "000"
}

deck_body() {
  cat "$1/response.json"
}

# CLI 版 install-deck。UI と同じサンドボックスで走らせ、終了コードだけ返す。
# 標準出力と標準エラーはファイルへ落とし、呼び出し側が個別に読む。
run_deck_cli() {
  local tmp_dir="$1"
  shift
  MY_SKILLS_LOCK_FILE="$tmp_dir/skills.lock.json" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" \
    MY_SKILLS_PROJECT_DECKS_DIR="$tmp_dir/project-decks" \
    MY_SKILLS_IGNORE_FILE="$tmp_dir/skills-ignore.json" \
    ./skill-loom "$@" > "$tmp_dir/cli-stdout.txt" 2> "$tmp_dir/cli-stderr.txt" \
    && echo 0 || echo $?
}

test_project_deck_get_uses_sandboxed_paths() {
  echo "Running test_project_deck_get_uses_sandboxed_paths..."
  local port=18830
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_deck_fixture "$tmp_dir"
  start_deck_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local json
    json=$(deck_get "$port" "/api/project-decks/e2e-deck")

    assert_contains "$json" '"decks":["e2e-deck"]' \
      && pass "test_project_deck_get_uses_sandboxed_paths: deck list comes from the sandbox" \
      || fail "test_project_deck_get_uses_sandboxed_paths: deck list not sandboxed"

    ! assert_contains "$json" '"agentic-ui"' \
      && pass "test_project_deck_get_uses_sandboxed_paths: real project-decks stay out" \
      || fail "test_project_deck_get_uses_sandboxed_paths: real project deck leaked in"

    assert_contains "$json" '"page":"project-deck"' \
      && pass "test_project_deck_get_uses_sandboxed_paths: page is project-deck" \
      || fail "test_project_deck_get_uses_sandboxed_paths: page wrong"

    assert_contains "$json" '"deckName":"e2e-deck"' \
      && pass "test_project_deck_get_uses_sandboxed_paths: deck name echoed" \
      || fail "test_project_deck_get_uses_sandboxed_paths: deck name missing"

    assert_contains "$json" '"skillNames":["alpha"]' \
      && pass "test_project_deck_get_uses_sandboxed_paths: deck skills come from the sandbox deck" \
      || fail "test_project_deck_get_uses_sandboxed_paths: deck skills wrong"

    assert_contains "$json" '"installCommands"' \
      && pass "test_project_deck_get_uses_sandboxed_paths: has install commands" \
      || fail "test_project_deck_get_uses_sandboxed_paths: install commands missing"

    local catalog
    catalog=$(deck_get "$port" "/api/project-decks/e2e-deck?catalog=1")

    assert_contains "$catalog" '"showCatalog":true' \
      && pass "test_project_deck_get_uses_sandboxed_paths: catalog=1 opens the catalog" \
      || fail "test_project_deck_get_uses_sandboxed_paths: catalog flag not set"

    assert_contains "$catalog" '"name":"beta"' \
      && pass "test_project_deck_get_uses_sandboxed_paths: catalog lists non-deck skills" \
      || fail "test_project_deck_get_uses_sandboxed_paths: catalog missing non-deck skill"

    ! assert_contains "$json" '"name":"beta"' \
      && pass "test_project_deck_get_uses_sandboxed_paths: default view keeps deck scope" \
      || fail "test_project_deck_get_uses_sandboxed_paths: default view leaked non-deck skill"

    local missing_code
    missing_code=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://localhost:${port}/api/project-decks/no-such-deck" 2>/dev/null || echo "000")

    [ "$missing_code" = "404" ] \
      && pass "test_project_deck_get_uses_sandboxed_paths: unknown deck is 404" \
      || fail "test_project_deck_get_uses_sandboxed_paths: got HTTP $missing_code"

    assert_contains "$(deck_get "$port" "/api/project-decks/no-such-deck")" "Unknown project deck: no-such-deck" \
      && pass "test_project_deck_get_uses_sandboxed_paths: unknown deck message" \
      || fail "test_project_deck_get_uses_sandboxed_paths: unknown deck message missing"
  else
    fail "test_project_deck_get_uses_sandboxed_paths: server did not start"
  fi
}

test_project_deck_create_empty() {
  echo "Running test_project_deck_create_empty..."
  local port=18835
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_deck_fixture "$tmp_dir"
  start_deck_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks" '{"name":"fresh"}')

    [ "$http_code" = "200" ] \
      && pass "test_project_deck_create_empty: HTTP 200" \
      || fail "test_project_deck_create_empty: got HTTP $http_code"

    assert_contains "$(deck_body "$tmp_dir")" "Created deck: fresh" \
      && pass "test_project_deck_create_empty: reports created name" \
      || fail "test_project_deck_create_empty: created message missing"

    assert_contains "$(deck_body "$tmp_dir")" '"decks":["e2e-deck","fresh"]' \
      && pass "test_project_deck_create_empty: deck list includes fresh" \
      || fail "test_project_deck_create_empty: deck list not updated"

    assert_contains "$(deck_body "$tmp_dir")" '"deckName":"fresh"' \
      && pass "test_project_deck_create_empty: payload targets new deck" \
      || fail "test_project_deck_create_empty: deckName missing"

    [ -f "$tmp_dir/project-decks/fresh.json" ] \
      && assert_matches "$(< "$tmp_dir/project-decks/fresh.json")" '"skills": \[\]' \
      && pass "test_project_deck_create_empty: empty deck file written" \
      || fail "test_project_deck_create_empty: deck file missing or not empty"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks" '{"name":"fresh"}')

    [ "$http_code" = "409" ] \
      && pass "test_project_deck_create_empty: duplicate is 409" \
      || fail "test_project_deck_create_empty: duplicate got HTTP $http_code"

    assert_contains "$(deck_body "$tmp_dir")" "Project deck already exists: fresh" \
      && pass "test_project_deck_create_empty: names the duplicate" \
      || fail "test_project_deck_create_empty: duplicate message missing"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks" '{"name":"Bad Name"}')

    [ "$http_code" = "400" ] \
      && pass "test_project_deck_create_empty: invalid name is 400" \
      || fail "test_project_deck_create_empty: invalid name got HTTP $http_code"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks" '{}')

    [ "$http_code" = "400" ] \
      && pass "test_project_deck_create_empty: missing name is 400" \
      || fail "test_project_deck_create_empty: missing name got HTTP $http_code"
  else
    fail "test_project_deck_create_empty: server did not start"
  fi
}

test_project_deck_save_persists_selection() {
  echo "Running test_project_deck_save_persists_selection..."
  local port=18831
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_deck_fixture "$tmp_dir"
  start_deck_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks/e2e-deck/save" '{"skills":["alpha","beta"]}')

    [ "$http_code" = "200" ] \
      && pass "test_project_deck_save_persists_selection: HTTP 200" \
      || fail "test_project_deck_save_persists_selection: got HTTP $http_code"

    assert_contains "$(deck_body "$tmp_dir")" "Saved deck: 2 direct skills" \
      && pass "test_project_deck_save_persists_selection: reports saved count" \
      || fail "test_project_deck_save_persists_selection: saved count missing"

    assert_contains "$(deck_body "$tmp_dir")" '"skillNames":["alpha","beta"]' \
      && pass "test_project_deck_save_persists_selection: payload reflects new selection" \
      || fail "test_project_deck_save_persists_selection: payload not refreshed"

    assert_matches "$(< "$tmp_dir/project-decks/e2e-deck.json")" '"alpha"' \
      && assert_matches "$(< "$tmp_dir/project-decks/e2e-deck.json")" '"beta"' \
      && pass "test_project_deck_save_persists_selection: deck file rewritten" \
      || fail "test_project_deck_save_persists_selection: deck file not rewritten"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks/e2e-deck/save" '{"skills":[]}')

    [ "$http_code" = "200" ] \
      && assert_contains "$(deck_body "$tmp_dir")" "Saved deck: 0 direct skills" \
      && pass "test_project_deck_save_persists_selection: empty selection clears the deck" \
      || fail "test_project_deck_save_persists_selection: empty selection rejected"
  else
    fail "test_project_deck_save_persists_selection: server did not start"
  fi
}

# ADR 0005: Project Deck の Apply は Core Deck を自動 union する。
# フィクスチャは core deck の skill を archive に置いてあるので、deck 側で選んでいない
# core skill が active へ戻れば「自動 union された」ことになる。
test_project_deck_apply_unions_core_deck() {
  echo "Running test_project_deck_apply_unions_core_deck..."
  local port=18832
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_deck_fixture "$tmp_dir"
  local core_sample expected_count
  core_sample=$(< "$tmp_dir/core-sample")
  expected_count=$(< "$tmp_dir/apply-target-count")
  start_deck_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks/e2e-deck/apply" '{"skills":["alpha"]}')

    [ "$http_code" = "200" ] \
      && pass "test_project_deck_apply_unions_core_deck: HTTP 200" \
      || fail "test_project_deck_apply_unions_core_deck: got HTTP $http_code"

    [ -d "$tmp_dir/active/$core_sample" ] \
      && pass "test_project_deck_apply_unions_core_deck: core skill restored to active" \
      || fail "test_project_deck_apply_unions_core_deck: $core_sample not active"

    [ ! -e "$tmp_dir/archive/$core_sample" ] \
      && pass "test_project_deck_apply_unions_core_deck: core skill left the archive" \
      || fail "test_project_deck_apply_unions_core_deck: $core_sample still archived"

    [ -L "$tmp_dir/claude-skills/$core_sample" ] \
      && pass "test_project_deck_apply_unions_core_deck: core skill linked for claude" \
      || fail "test_project_deck_apply_unions_core_deck: claude symlink missing"

    [ -L "$tmp_dir/gemini-skills/$core_sample" ] \
      && pass "test_project_deck_apply_unions_core_deck: core skill linked for gemini" \
      || fail "test_project_deck_apply_unions_core_deck: gemini symlink missing"

    [ -d "$tmp_dir/active/alpha" ] \
      && pass "test_project_deck_apply_unions_core_deck: deck skill stays active" \
      || fail "test_project_deck_apply_unions_core_deck: alpha dropped"

    [ -e "$tmp_dir/archive/beta" ] && [ ! -e "$tmp_dir/active/beta" ] \
      && pass "test_project_deck_apply_unions_core_deck: off-deck skill archived" \
      || fail "test_project_deck_apply_unions_core_deck: beta still active"

    assert_contains "$(deck_body "$tmp_dir")" "Applied: active target ${expected_count}" \
      && pass "test_project_deck_apply_unions_core_deck: target counts core + deck skills" \
      || fail "test_project_deck_apply_unions_core_deck: target count wrong"
  else
    fail "test_project_deck_apply_unions_core_deck: server did not start"
  fi
}

# ADR 0005 の後半: merge モードは既存 Active との union だけを行い、Core Deck を足さない。
# apply 側と同じフィクスチャなので、archive に残るかどうかが両モードの唯一の差になる。
test_project_deck_merge_does_not_add_core_deck() {
  echo "Running test_project_deck_merge_does_not_add_core_deck..."
  local port=18833
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_deck_fixture "$tmp_dir"
  local core_sample
  core_sample=$(< "$tmp_dir/core-sample")
  start_deck_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks/e2e-deck/merge" '{"skills":["alpha"]}')

    [ "$http_code" = "200" ] \
      && pass "test_project_deck_merge_does_not_add_core_deck: HTTP 200" \
      || fail "test_project_deck_merge_does_not_add_core_deck: got HTTP $http_code"

    [ ! -e "$tmp_dir/active/$core_sample" ] \
      && pass "test_project_deck_merge_does_not_add_core_deck: core skill not auto-added" \
      || fail "test_project_deck_merge_does_not_add_core_deck: $core_sample was activated"

    [ -d "$tmp_dir/archive/$core_sample" ] \
      && pass "test_project_deck_merge_does_not_add_core_deck: core skill stays archived" \
      || fail "test_project_deck_merge_does_not_add_core_deck: $core_sample left the archive"

    [ ! -e "$tmp_dir/claude-skills/$core_sample" ] \
      && pass "test_project_deck_merge_does_not_add_core_deck: no agent symlink for core skill" \
      || fail "test_project_deck_merge_does_not_add_core_deck: core skill linked for claude"

    [ -d "$tmp_dir/active/alpha" ] && [ -d "$tmp_dir/active/beta" ] \
      && pass "test_project_deck_merge_does_not_add_core_deck: keeps the existing active set" \
      || fail "test_project_deck_merge_does_not_add_core_deck: active set changed"

    assert_contains "$(deck_body "$tmp_dir")" "Applied: active target 2" \
      && pass "test_project_deck_merge_does_not_add_core_deck: target is active union selection" \
      || fail "test_project_deck_merge_does_not_add_core_deck: target count wrong"
  else
    fail "test_project_deck_merge_does_not_add_core_deck: server did not start"
  fi
}

test_project_deck_action_rejects_bad_requests() {
  echo "Running test_project_deck_action_rejects_bad_requests..."
  local port=18834
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_deck_fixture "$tmp_dir"
  local core_sample
  core_sample=$(< "$tmp_dir/core-sample")
  start_deck_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks/no-such-deck/apply" '{"skills":["alpha"]}')

    [ "$http_code" = "404" ] \
      && pass "test_project_deck_action_rejects_bad_requests: apply on unknown deck is 404" \
      || fail "test_project_deck_action_rejects_bad_requests: got HTTP $http_code"

    assert_contains "$(deck_body "$tmp_dir")" "Unknown project deck: no-such-deck" \
      && pass "test_project_deck_action_rejects_bad_requests: names the unknown deck" \
      || fail "test_project_deck_action_rejects_bad_requests: unknown deck message missing"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks/no-such-deck/merge" '{"skills":["alpha"]}')

    [ "$http_code" = "404" ] \
      && pass "test_project_deck_action_rejects_bad_requests: merge on unknown deck is 404" \
      || fail "test_project_deck_action_rejects_bad_requests: merge got HTTP $http_code"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks/e2e-deck/bogus" '{"skills":["alpha"]}')

    [ "$http_code" = "404" ] \
      && pass "test_project_deck_action_rejects_bad_requests: unknown action is 404" \
      || fail "test_project_deck_action_rejects_bad_requests: unknown action got HTTP $http_code"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/project-decks/e2e-deck/apply" '{"skills":["ghost-skill"]}')

    [ "$http_code" = "400" ] \
      && pass "test_project_deck_action_rejects_bad_requests: unresolved skill is 400" \
      || fail "test_project_deck_action_rejects_bad_requests: unresolved got HTTP $http_code"

    assert_contains "$(deck_body "$tmp_dir")" "Unresolved: ghost-skill" \
      && pass "test_project_deck_action_rejects_bad_requests: names the unresolved skill" \
      || fail "test_project_deck_action_rejects_bad_requests: unresolved message missing"

    [ -d "$tmp_dir/archive/$core_sample" ] && [ -d "$tmp_dir/active/beta" ] \
      && pass "test_project_deck_action_rejects_bad_requests: rejected apply changed nothing" \
      || fail "test_project_deck_action_rejects_bad_requests: projection mutated on error"
  else
    fail "test_project_deck_action_rejects_bad_requests: server did not start"
  fi
}

test_drafts_list_reads_selected_catalog() {
  echo "Running test_drafts_list_reads_selected_catalog..."
  local port=18837
  local tmp_dir catalog_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  catalog_dir="$tmp_dir/catalog"
  mkdir -p "$catalog_dir/drafts/skills/engineering/catalog-draft" \
    "$catalog_dir/project-decks" "$catalog_dir/shared-decks" \
    "$tmp_dir/active" "$tmp_dir/archive" "$tmp_dir/claude-skills" "$tmp_dir/gemini-skills"
  printf -- '---\nname: catalog-draft\ndescription: Catalog draft fixture\n---\n' \
    > "$catalog_dir/drafts/skills/engineering/catalog-draft/SKILL.md"
  printf '{"version":1,"custom":{"repo":"owner/catalog","skills":{}},"external":{},"vendor":{}}\n' > "$catalog_dir/skills.lock.json"
  printf '{"ignore":[]}\n' > "$catalog_dir/.skills-ignore.json"

  MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" MY_SKILLS_AUTO_COMMIT=0 \
    ./skill-loom ui --catalog-dir "$catalog_dir" --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local json
    json=$(deck_get "$port" "/api/drafts")
    assert_contains "$json" '"name":"catalog-draft"' \
      && assert_contains "$json" '"source":"drafts/skills/engineering/catalog-draft"' \
      && pass "test_drafts_list_reads_selected_catalog: selected Catalog Draft listed" \
      || fail "test_drafts_list_reads_selected_catalog: body=$json"
  else
    fail "test_drafts_list_reads_selected_catalog: server did not start"
  fi
}

test_drafts_promote_writes_selected_catalog() {
  echo "Running test_drafts_promote_writes_selected_catalog..."
  local port=18838
  local tmp_dir catalog_dir draft_name
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  catalog_dir="$tmp_dir/catalog"
  draft_name="e2e-catalog-draft-promote"
  mkdir -p "$catalog_dir/drafts/skills/engineering/$draft_name" \
    "$catalog_dir/project-decks" "$catalog_dir/shared-decks" \
    "$tmp_dir/active" "$tmp_dir/archive" "$tmp_dir/claude-skills" "$tmp_dir/gemini-skills"
  printf -- '---\nname: %s\ndescription: Catalog promotion fixture\n---\n' "$draft_name" \
    > "$catalog_dir/drafts/skills/engineering/$draft_name/SKILL.md"
  printf '{"version":1,"custom":{"repo":"owner/catalog","skills":{}},"external":{},"vendor":{}}\n' > "$catalog_dir/skills.lock.json"
  printf '{"ignore":[]}\n' > "$catalog_dir/.skills-ignore.json"
  cat > "$tmp_dir/trash-stub" <<'SH'
#!/bin/bash
set -euo pipefail
mv "$1" "$MY_SKILLS_TRASH_DEST"
SH
  chmod +x "$tmp_dir/trash-stub"
  git -C "$catalog_dir" init -q
  git -C "$catalog_dir" config user.name "Skill Loom Test"
  git -C "$catalog_dir" config user.email "skill-loom@example.invalid"
  git -C "$catalog_dir" config core.hooksPath /dev/null
  git -C "$catalog_dir" add .
  git -C "$catalog_dir" commit -qm "test: Catalog baseline"

  MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" \
    MY_SKILLS_TRASH_BIN="$tmp_dir/trash-stub" MY_SKILLS_TRASH_DEST="$tmp_dir/trashed-draft" \
    ./skill-loom ui --catalog-dir "$catalog_dir" --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code committed status
    http_code=$(deck_post "$tmp_dir" "$port" "/api/drafts/promote" "{\"skills\":[\"$draft_name\"]}")
    committed=$(git -C "$catalog_dir" show --name-status --format= HEAD)
    status=$(git -C "$catalog_dir" status --short)

    [ "$http_code" = "200" ] \
      && [ -f "$catalog_dir/skills/engineering/$draft_name/SKILL.md" ] \
      && [ ! -e "$catalog_dir/drafts/skills/engineering/$draft_name" ] \
      && assert_contains "$(cat "$catalog_dir/skills.lock.json")" "skills/engineering/$draft_name" \
      && [ ! -e "$REPO_ROOT/skills/engineering/$draft_name" ] \
      && assert_contains "$committed" "skills.lock.json" \
      && assert_contains "$committed" "skills/engineering/$draft_name/SKILL.md" \
      && assert_contains "$committed" "drafts/skills/engineering/$draft_name/SKILL.md" \
      && [ -z "$status" ] \
      && pass "test_drafts_promote_writes_selected_catalog: promotion stayed in Catalog" \
      || fail "test_drafts_promote_writes_selected_catalog: code=$http_code status=$status commit=$committed body=$(deck_body "$tmp_dir")"
  else
    fail "test_drafts_promote_writes_selected_catalog: server did not start"
  fi
}

test_drafts_action_rejects_bad_requests() {
  echo "Running test_drafts_action_rejects_bad_requests..."
  local port=18836
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_deck_fixture "$tmp_dir"

  # 既に custom 登録済みの名前を draft として置くと promote は確認待ちになる。
  local draft_dir="$tmp_dir/drafts/skills/engineering/e2e-draft-conflict"
  mkdir -p "$draft_dir"
  printf -- '---\nname: e2e-draft-conflict\ndescription: E2E draft conflict fixture\n---\n' > "$draft_dir/SKILL.md"
  bun -e '
const fs=require("node:fs");
const lockFile=process.argv[1]+"/skills.lock.json";
const lock=JSON.parse(fs.readFileSync(lockFile,"utf8"));
lock.custom.skills["e2e-draft-conflict"]={repoPath:"skills/engineering/e2e-draft-conflict",category:"engineering"};
fs.writeFileSync(lockFile, JSON.stringify(lock,null,2));
' "$tmp_dir"

  start_deck_ui "$tmp_dir" "$port" "$tmp_dir"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(deck_post "$tmp_dir" "$port" "/api/drafts/promote" '{"skills":[]}')

    [ "$http_code" = "400" ] \
      && pass "test_drafts_action_rejects_bad_requests: empty selection is 400" \
      || fail "test_drafts_action_rejects_bad_requests: empty selection got HTTP $http_code"

    assert_contains "$(deck_body "$tmp_dir")" "draftを選択してください" \
      && pass "test_drafts_action_rejects_bad_requests: asks for a selection" \
      || fail "test_drafts_action_rejects_bad_requests: selection message missing"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/drafts/promote" '{"skills":["no-such-draft"]}')

    [ "$http_code" = "400" ] \
      && pass "test_drafts_action_rejects_bad_requests: unknown draft is 400" \
      || fail "test_drafts_action_rejects_bad_requests: unknown draft got HTTP $http_code"

    assert_contains "$(deck_body "$tmp_dir")" "Unknown drafts: no-such-draft" \
      && pass "test_drafts_action_rejects_bad_requests: names the unknown draft" \
      || fail "test_drafts_action_rejects_bad_requests: unknown draft message missing"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/drafts/bogus" '{"skills":["e2e-draft-conflict"]}')

    [ "$http_code" = "404" ] \
      && pass "test_drafts_action_rejects_bad_requests: unknown action is 404" \
      || fail "test_drafts_action_rejects_bad_requests: unknown action got HTTP $http_code"

    http_code=$(deck_post "$tmp_dir" "$port" "/api/drafts/promote" '{"skills":["e2e-draft-conflict"]}')

    [ "$http_code" = "409" ] \
      && pass "test_drafts_action_rejects_bad_requests: already registered draft is 409" \
      || fail "test_drafts_action_rejects_bad_requests: conflict got HTTP $http_code"

    assert_contains "$(deck_body "$tmp_dir")" '"confirmSelected":["e2e-draft-conflict"]' \
      && pass "test_drafts_action_rejects_bad_requests: asks for confirmation" \
      || fail "test_drafts_action_rejects_bad_requests: confirm list missing"

    [ -f "$draft_dir/SKILL.md" ] && [ ! -e "$tmp_dir/skills/engineering/e2e-draft-conflict" ] \
      && pass "test_drafts_action_rejects_bad_requests: conflict promotes nothing" \
      || fail "test_drafts_action_rejects_bad_requests: conflict mutated the Catalog"
  else
    fail "test_drafts_action_rejects_bad_requests: server did not start"
  fi
}

# CLI の install-deck。UI の Apply と違って「足す」だけで、deck に無い active は
# archive へ落とさない。落とすようになると他の deck の作業中に足元が消える。
test_install_deck_cli_restores_from_archive() {
  echo "Running test_install_deck_cli_restores_from_archive..."
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_deck_fixture "$tmp_dir"

  local core_sample
  core_sample=$(< "$tmp_dir/core-sample")
  bun -e '
const fs=require("node:fs");
const tmp=process.argv[1], sample=process.argv[2];
fs.writeFileSync(tmp+"/project-decks/e2e-install.json", JSON.stringify({name:"e2e-install",skills:["alpha",sample]},null,2));
' "$tmp_dir" "$core_sample"

  local rc
  rc=$(run_deck_cli "$tmp_dir" install-deck e2e-install)
  local out
  out=$(< "$tmp_dir/cli-stdout.txt")

  [ "$rc" = "0" ] \
    && pass "test_install_deck_cli_restores_from_archive: exit code 0" \
    || fail "test_install_deck_cli_restores_from_archive: exit code $rc"

  assert_contains "$out" "deck:           e2e-install" \
    && pass "test_install_deck_cli_restores_from_archive: reports the deck name" \
    || fail "test_install_deck_cli_restores_from_archive: deck name missing"

  assert_contains "$out" "already active: 1" \
    && pass "test_install_deck_cli_restores_from_archive: counts the active skill" \
    || fail "test_install_deck_cli_restores_from_archive: already active wrong"

  assert_contains "$out" "restored:       1" \
    && pass "test_install_deck_cli_restores_from_archive: counts the restored skill" \
    || fail "test_install_deck_cli_restores_from_archive: restored wrong"

  assert_contains "$out" "installed:      0" \
    && pass "test_install_deck_cli_restores_from_archive: nothing had to be installed" \
    || fail "test_install_deck_cli_restores_from_archive: installed wrong"

  [ -d "$tmp_dir/active/$core_sample" ] \
    && pass "test_install_deck_cli_restores_from_archive: skill moved into active" \
    || fail "test_install_deck_cli_restores_from_archive: skill not restored"

  [ -L "$tmp_dir/claude-skills/$core_sample" ] \
    && pass "test_install_deck_cli_restores_from_archive: agent symlink relinked" \
    || fail "test_install_deck_cli_restores_from_archive: agent symlink missing"

  [ -d "$tmp_dir/active/beta" ] \
    && pass "test_install_deck_cli_restores_from_archive: deck 外の active は残る" \
    || fail "test_install_deck_cli_restores_from_archive: beta was archived"
}

test_install_deck_cli_rejects_bad_requests() {
  echo "Running test_install_deck_cli_rejects_bad_requests..."
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_deck_fixture "$tmp_dir"

  bun -e '
const fs=require("node:fs");
const tmp=process.argv[1];
fs.writeFileSync(tmp+"/project-decks/e2e-unresolved.json", JSON.stringify({name:"e2e-unresolved",skills:["alpha","nowhere"]},null,2));
' "$tmp_dir"

  local rc
  rc=$(run_deck_cli "$tmp_dir" install-deck e2e-unresolved)

  [ "$rc" = "2" ] \
    && pass "test_install_deck_cli_rejects_bad_requests: unresolved exits 2" \
    || fail "test_install_deck_cli_rejects_bad_requests: unresolved exit code $rc"

  assert_contains "$(< "$tmp_dir/cli-stdout.txt")" "unresolved deck skills:" \
    && pass "test_install_deck_cli_rejects_bad_requests: lists unresolved skills" \
    || fail "test_install_deck_cli_rejects_bad_requests: unresolved list missing"

  [ -d "$tmp_dir/archive/$(< "$tmp_dir/core-sample")" ] \
    && pass "test_install_deck_cli_rejects_bad_requests: 解決できなければ何も動かさない" \
    || fail "test_install_deck_cli_rejects_bad_requests: projection was touched"

  rc=$(run_deck_cli "$tmp_dir" install-deck no-such-deck)

  [ "$rc" = "1" ] \
    && pass "test_install_deck_cli_rejects_bad_requests: unknown deck exits 1" \
    || fail "test_install_deck_cli_rejects_bad_requests: unknown deck exit code $rc"

  assert_contains "$(< "$tmp_dir/cli-stderr.txt")" "Unknown project deck: no-such-deck" \
    && pass "test_install_deck_cli_rejects_bad_requests: names the missing deck" \
    || fail "test_install_deck_cli_rejects_bad_requests: unknown deck message missing"
}

register_cases \
  test_project_deck_get_uses_sandboxed_paths \
  test_project_deck_create_empty \
  test_project_deck_save_persists_selection \
  test_project_deck_apply_unions_core_deck \
  test_project_deck_merge_does_not_add_core_deck \
  test_project_deck_action_rejects_bad_requests \
  test_drafts_list_reads_selected_catalog \
  test_drafts_promote_writes_selected_catalog \
  test_drafts_action_rejects_bad_requests \
  test_install_deck_cli_restores_from_archive \
  test_install_deck_cli_rejects_bad_requests
