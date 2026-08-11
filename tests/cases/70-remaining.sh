# 残っていた HTTP seam（bulk-off / custom update / external sources・preview・deck追加 / OGP）
#
# ここのテストはどれも presets・project-decks・.skills-ignore まで書き換える経路を通る。
# 1 つでも実ホームやリポジトリに漏れると開発者の設定が壊れるため、UI の起動は必ず
# start_remaining_ui() 経由にすること。MY_SKILLS_AUTO_COMMIT=0 は add-to-deck が
# 本物の git commit を作るのを止めるために必須。
start_remaining_ui() {
  local tmp_dir="$1" port="$2" candidates="${3:-}"
  mkdir -p "$tmp_dir/presets" "$tmp_dir/project-decks"
  MY_SKILLS_LOCK_FILE="$tmp_dir/skills.lock.json" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" \
    MY_SKILLS_PRESETS_DIR="$tmp_dir/presets" \
    MY_SKILLS_PROJECT_DECKS_DIR="$tmp_dir/project-decks" \
    MY_SKILLS_IGNORE_FILE="$tmp_dir/.skills-ignore.json" \
    MY_SKILLS_EXTERNAL_CANDIDATES_FILE="$candidates" \
    MY_SKILLS_AUTO_COMMIT=0 \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2
}

# custom skill の drift 判定は repoPath を REPO_ROOT 相対で解決するので、リポジトリ内に
# 実体を置くしかない。tests/tmp/ 配下に作り、TMP_DIRS で必ず片付ける。
setup_custom_drift_fixture() {
  local tmp_dir="$1" repo_fixture="$2"
  shift 2
  mkdir -p "$tmp_dir/active" "$tmp_dir/archive" "$tmp_dir/claude-skills" "$tmp_dir/gemini-skills"
  mkdir -p "$REPO_ROOT/$repo_fixture"
  TMP_DIRS+=("$REPO_ROOT/$repo_fixture")

  local entries=""
  for skill in "$@"; do
    mkdir -p "$REPO_ROOT/$repo_fixture/$skill" "$tmp_dir/active/$skill"
    printf -- '---\nname: %s\ndescription: repo version\n---\n' "$skill" \
      > "$REPO_ROOT/$repo_fixture/$skill/SKILL.md"
    printf -- '---\nname: %s\ndescription: installed version\n---\n' "$skill" \
      > "$tmp_dir/active/$skill/SKILL.md"
    [ -n "$entries" ] && entries="$entries,"
    entries="$entries
      \"$skill\": {\"repoPath\": \"$repo_fixture/$skill\", \"category\": \"e2e\"}"
  done

  cat > "$tmp_dir/skills.lock.json" <<JSON
{
  "version": 1,
  "custom": {
    "repo": "owner/catalog",
    "skills": {$entries
    }
  },
  "external": {},
  "vendor": {}
}
JSON
}

post_json() {
  local tmp_dir="$1" port="$2" path="$3" body="$4"
  curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
    -X POST "http://localhost:${port}${path}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null || echo "000"
}

test_bulk_off_turns_off_every_managed_active_skill() {
  echo "Running test_bulk_off_turns_off_every_managed_active_skill..."
  local port=18901
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/bulk-off" '{}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "200" ] \
      && pass "test_bulk_off_turns_off_every_managed_active_skill: returns 200" \
      || fail "test_bulk_off_turns_off_every_managed_active_skill: expected 200, got $code"

    assert_contains "$body" 'すべてオフにしました (2): alpha, beta' \
      && pass "test_bulk_off_turns_off_every_managed_active_skill: reports both skills" \
      || fail "test_bulk_off_turns_off_every_managed_active_skill: message missing"

    [ ! -e "$tmp_dir/active/alpha" ] && [ ! -e "$tmp_dir/active/beta" ] \
      && pass "test_bulk_off_turns_off_every_managed_active_skill: active dir cleared" \
      || fail "test_bulk_off_turns_off_every_managed_active_skill: active dir still populated"

    [ ! -e "$tmp_dir/claude-skills/alpha" ] && [ ! -e "$tmp_dir/gemini-skills/beta" ] \
      && pass "test_bulk_off_turns_off_every_managed_active_skill: agent symlinks unlinked" \
      || fail "test_bulk_off_turns_off_every_managed_active_skill: agent symlinks remain"

    # off にした集合は _last preset に退避され、Restore で戻せる必要がある。
    assert_contains "$(cat "$tmp_dir/presets/_last.json" 2>/dev/null || true)" '"alpha"' \
      && pass "test_bulk_off_turns_off_every_managed_active_skill: backs up to _last preset" \
      || fail "test_bulk_off_turns_off_every_managed_active_skill: _last preset not written"
  else
    fail "test_bulk_off_turns_off_every_managed_active_skill: server did not start"
  fi
}

test_bulk_off_without_active_returns_400() {
  echo "Running test_bulk_off_without_active_returns_400..."
  local port=18902
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    post_json "$tmp_dir" "$port" "/api/bulk-off" '{}' > /dev/null

    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/bulk-off" '{}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "400" ] \
      && pass "test_bulk_off_without_active_returns_400: second call returns 400" \
      || fail "test_bulk_off_without_active_returns_400: expected 400, got $code"

    assert_contains "$body" 'No managed active skills to turn off' \
      && pass "test_bulk_off_without_active_returns_400: explains why" \
      || fail "test_bulk_off_without_active_returns_400: reason missing"
  else
    fail "test_bulk_off_without_active_returns_400: server did not start"
  fi
}

test_custom_check_updates_reports_drifted_skills() {
  echo "Running test_custom_check_updates_reports_drifted_skills..."
  local port=18903
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_custom_drift_fixture "$tmp_dir" "tests/tmp/check-updates" gamma
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/custom/check-updates" '{}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "200" ] \
      && pass "test_custom_check_updates_reports_drifted_skills: returns 200" \
      || fail "test_custom_check_updates_reports_drifted_skills: expected 200, got $code"

    assert_contains "$body" '更新確認完了: 更新あり 1 skills' \
      && pass "test_custom_check_updates_reports_drifted_skills: counts drifted skills" \
      || fail "test_custom_check_updates_reports_drifted_skills: count missing"

    assert_contains "$body" '"customUpdatesChecked":true' \
      && pass "test_custom_check_updates_reports_drifted_skills: marks payload as checked" \
      || fail "test_custom_check_updates_reports_drifted_skills: checked flag missing"

    assert_contains "$body" '"name":"gamma"' \
      && pass "test_custom_check_updates_reports_drifted_skills: names the drifted skill" \
      || fail "test_custom_check_updates_reports_drifted_skills: drifted skill missing"

    # 差分は diff まで返す。これがないと UI で何が変わるか確認せずに update する。
    assert_contains "$body" 'installed version' \
      && pass "test_custom_check_updates_reports_drifted_skills: includes SKILL.md diff" \
      || fail "test_custom_check_updates_reports_drifted_skills: diff missing"
  else
    fail "test_custom_check_updates_reports_drifted_skills: server did not start"
  fi
}

test_custom_check_updates_reports_up_to_date() {
  echo "Running test_custom_check_updates_reports_up_to_date..."
  local port=18904
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_custom_drift_fixture "$tmp_dir" "tests/tmp/up-to-date" gamma
  # インストール済みをリポジトリ側と一致させれば drift は消える。
  cp "$REPO_ROOT/tests/tmp/up-to-date/gamma/SKILL.md" "$tmp_dir/active/gamma/SKILL.md"
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/custom/check-updates" '{}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "200" ] \
      && pass "test_custom_check_updates_reports_up_to_date: returns 200" \
      || fail "test_custom_check_updates_reports_up_to_date: expected 200, got $code"

    assert_contains "$body" '更新確認完了: すべて最新です' \
      && pass "test_custom_check_updates_reports_up_to_date: reports up to date" \
      || fail "test_custom_check_updates_reports_up_to_date: message missing"

    assert_contains "$body" '"customUpdatable":[]' \
      && pass "test_custom_check_updates_reports_up_to_date: no updatable rows" \
      || fail "test_custom_check_updates_reports_up_to_date: updatable rows not empty"
  else
    fail "test_custom_check_updates_reports_up_to_date: server did not start"
  fi
}

test_custom_update_overwrites_installed_copy_from_repo() {
  echo "Running test_custom_update_overwrites_installed_copy_from_repo..."
  local port=18905
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_custom_drift_fixture "$tmp_dir" "tests/tmp/update-one" gamma
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/custom/update" '{"skill":"gamma"}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "200" ] \
      && pass "test_custom_update_overwrites_installed_copy_from_repo: returns 200" \
      || fail "test_custom_update_overwrites_installed_copy_from_repo: expected 200, got $code"

    assert_contains "$body" 'updated: gamma' \
      && pass "test_custom_update_overwrites_installed_copy_from_repo: reports the skill" \
      || fail "test_custom_update_overwrites_installed_copy_from_repo: message missing"

    assert_contains "$(cat "$tmp_dir/active/gamma/SKILL.md")" 'repo version' \
      && pass "test_custom_update_overwrites_installed_copy_from_repo: installed copy replaced" \
      || fail "test_custom_update_overwrites_installed_copy_from_repo: installed copy unchanged"

    # update 後の payload はそのまま UI に反映されるので、drift が残っていてはいけない。
    assert_contains "$body" '"customUpdatable":[]' \
      && pass "test_custom_update_overwrites_installed_copy_from_repo: drift cleared in payload" \
      || fail "test_custom_update_overwrites_installed_copy_from_repo: drift still reported"

    # active な custom skill は agent 側の symlink も張り直される。
    [ -L "$tmp_dir/claude-skills/gamma" ] && [ -L "$tmp_dir/gemini-skills/gamma" ] \
      && pass "test_custom_update_overwrites_installed_copy_from_repo: relinks agent dirs" \
      || fail "test_custom_update_overwrites_installed_copy_from_repo: agent symlinks missing"
  else
    fail "test_custom_update_overwrites_installed_copy_from_repo: server did not start"
  fi
}

test_custom_update_reads_source_from_selected_catalog() {
  echo "Running test_custom_update_reads_source_from_selected_catalog..."
  local port=18916
  local tmp_dir catalog_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  catalog_dir="$tmp_dir/catalog"
  mkdir -p "$catalog_dir/skills/engineering/gamma" "$catalog_dir/project-decks" \
    "$catalog_dir/shared-decks" "$tmp_dir/active/gamma" "$tmp_dir/archive" \
    "$tmp_dir/claude-skills" "$tmp_dir/gemini-skills" "$tmp_dir/presets"

  printf -- '---\nname: gamma\ndescription: Catalog version\n---\n' \
    > "$catalog_dir/skills/engineering/gamma/SKILL.md"
  printf -- '---\nname: gamma\ndescription: installed version\n---\n' \
    > "$tmp_dir/active/gamma/SKILL.md"
  cat > "$catalog_dir/skills.lock.json" <<'JSON'
{"version":1,"custom":{"repo":"owner/catalog","skills":{"gamma":{"repoPath":"skills/engineering/gamma","category":"engineering"}}},"external":{},"vendor":{}}
JSON
  printf '{"ignore":[]}\n' > "$catalog_dir/.skills-ignore.json"

  MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" \
    MY_SKILLS_PRESETS_DIR="$tmp_dir/presets" MY_SKILLS_AUTO_COMMIT=0 \
    ./skill-loom ui --catalog-dir "$catalog_dir" --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local code
    code=$(post_json "$tmp_dir" "$port" "/api/custom/update" '{"skill":"gamma"}')

    [ "$code" = "200" ] \
      && assert_contains "$(cat "$tmp_dir/active/gamma/SKILL.md")" "Catalog version" \
      && pass "test_custom_update_reads_source_from_selected_catalog: Catalog source applied" \
      || fail "test_custom_update_reads_source_from_selected_catalog: code=$code body=$(cat "$tmp_dir/response.json")"
  else
    fail "test_custom_update_reads_source_from_selected_catalog: server did not start"
  fi
}

test_custom_update_rejects_bad_requests() {
  echo "Running test_custom_update_rejects_bad_requests..."
  local port=18906
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_custom_drift_fixture "$tmp_dir" "tests/tmp/update-reject" gamma
  # インストールされていない custom skill も lock に載せておく。
  "$MY_SKILLS_TRASH_BIN" "$tmp_dir/active/gamma"
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local code body

    code=$(post_json "$tmp_dir" "$port" "/api/custom/update" '{}')
    body=$(cat "$tmp_dir/response.json")
    [ "$code" = "400" ] && assert_contains "$body" 'updateするskillを選択してください' \
      && pass "test_custom_update_rejects_bad_requests: empty skill returns 400" \
      || fail "test_custom_update_rejects_bad_requests: empty skill got $code"

    code=$(post_json "$tmp_dir" "$port" "/api/custom/update" '{"skill":"nonexistent"}')
    body=$(cat "$tmp_dir/response.json")
    [ "$code" = "400" ] && assert_contains "$body" 'custom skill ではありません: nonexistent' \
      && pass "test_custom_update_rejects_bad_requests: unknown skill returns 400" \
      || fail "test_custom_update_rejects_bad_requests: unknown skill got $code"

    code=$(post_json "$tmp_dir" "$port" "/api/custom/update" '{"skill":"gamma"}')
    body=$(cat "$tmp_dir/response.json")
    [ "$code" = "400" ] && assert_contains "$body" '展開されていないため update できません: gamma' \
      && pass "test_custom_update_rejects_bad_requests: uninstalled skill returns 400" \
      || fail "test_custom_update_rejects_bad_requests: uninstalled skill got $code"
  else
    fail "test_custom_update_rejects_bad_requests: server did not start"
  fi
}

test_custom_update_all_updates_every_drifted_skill() {
  echo "Running test_custom_update_all_updates_every_drifted_skill..."
  local port=18907
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_custom_drift_fixture "$tmp_dir" "tests/tmp/update-all" gamma delta
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    # skills を省略すると drift のある全 skill が対象になる。
    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/custom/update-all" '{}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "200" ] \
      && pass "test_custom_update_all_updates_every_drifted_skill: returns 200" \
      || fail "test_custom_update_all_updates_every_drifted_skill: expected 200, got $code"

    assert_contains "$body" 'updated: delta, gamma' \
      && pass "test_custom_update_all_updates_every_drifted_skill: reports both skills" \
      || fail "test_custom_update_all_updates_every_drifted_skill: message missing"

    assert_contains "$(cat "$tmp_dir/active/gamma/SKILL.md")" 'repo version' \
      && assert_contains "$(cat "$tmp_dir/active/delta/SKILL.md")" 'repo version' \
      && pass "test_custom_update_all_updates_every_drifted_skill: both copies replaced" \
      || fail "test_custom_update_all_updates_every_drifted_skill: a copy is unchanged"
  else
    fail "test_custom_update_all_updates_every_drifted_skill: server did not start"
  fi
}

test_custom_update_all_rejects_bad_requests() {
  echo "Running test_custom_update_all_rejects_bad_requests..."
  local port=18908
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_custom_drift_fixture "$tmp_dir" "tests/tmp/update-all-reject" gamma
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local code body

    code=$(post_json "$tmp_dir" "$port" "/api/custom/update-all" '{"skills":["nonexistent"]}')
    body=$(cat "$tmp_dir/response.json")
    [ "$code" = "400" ] && assert_contains "$body" 'custom skill ではありません: nonexistent' \
      && pass "test_custom_update_all_rejects_bad_requests: unknown skill returns 400" \
      || fail "test_custom_update_all_rejects_bad_requests: unknown skill got $code"

    # drift を解消してから skills 省略で叩くと対象ゼロになる。
    post_json "$tmp_dir" "$port" "/api/custom/update-all" '{"skills":["gamma"]}' > /dev/null
    code=$(post_json "$tmp_dir" "$port" "/api/custom/update-all" '{}')
    body=$(cat "$tmp_dir/response.json")
    [ "$code" = "400" ] && assert_contains "$body" '更新対象のskillはありません' \
      && pass "test_custom_update_all_rejects_bad_requests: nothing to update returns 400" \
      || fail "test_custom_update_all_rejects_bad_requests: nothing to update got $code"
  else
    fail "test_custom_update_all_rejects_bad_requests: server did not start"
  fi
}

test_external_sources_groups_skills_by_repo() {
  echo "Running test_external_sources_groups_skills_by_repo..."
  local port=18909
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  mkdir -p "$tmp_dir/active" "$tmp_dir/archive"
  cat > "$tmp_dir/skills.lock.json" <<'JSON'
{
  "version": 1,
  "custom": {"repo": "owner/catalog", "skills": {}},
  "external": {
    "one": {"source": "owner-a/repo-a", "sourceUrl": "https://github.com/owner-a/repo-a.git", "skillPath": "skills/one/SKILL.md"},
    "two": {"source": "owner-a/repo-a", "sourceUrl": "https://github.com/owner-a/repo-a.git", "skillPath": "skills/two/SKILL.md"},
    "three": {"source": "owner-b/repo-b", "sourceUrl": "https://github.com/owner-b/repo-b.git", "skillPath": "skills/three/SKILL.md"}
  },
  "vendor": {}
}
JSON
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local body
    body=$(curl -s "http://localhost:${port}/api/external-sources" 2>/dev/null || true)

    assert_contains "$body" '"page":"external-sources"' \
      && pass "test_external_sources_groups_skills_by_repo: returns the sources page" \
      || fail "test_external_sources_groups_skills_by_repo: page marker missing"

    assert_contains "$body" '"source":"owner-a/repo-a","owner":"owner-a","repo":"repo-a"' \
      && pass "test_external_sources_groups_skills_by_repo: splits owner and repo" \
      || fail "test_external_sources_groups_skills_by_repo: owner/repo split missing"

    # 同じ repo の skill は 1 行にまとまる。
    assert_contains "$body" '"skills":["one","two"]' \
      && pass "test_external_sources_groups_skills_by_repo: groups same-repo skills" \
      || fail "test_external_sources_groups_skills_by_repo: grouping missing"

    assert_contains "$body" '"source":"owner-b/repo-b"' \
      && pass "test_external_sources_groups_skills_by_repo: lists the second repo" \
      || fail "test_external_sources_groups_skills_by_repo: second repo missing"

    # 未チェックのうちは更新件数を 0 に見せる。
    assert_contains "$body" '"totalUpdatable":0' \
      && pass "test_external_sources_groups_skills_by_repo: no updates before checking" \
      || fail "test_external_sources_groups_skills_by_repo: totalUpdatable not 0"
  else
    fail "test_external_sources_groups_skills_by_repo: server did not start"
  fi
}

test_external_preview_returns_candidate_rows() {
  echo "Running test_external_preview_returns_candidate_rows..."
  local port=18910
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  local fixture="$tmp_dir/candidates.json"
  cat > "$fixture" <<'JSON'
[
  {"name":"alpha","description":"Already installed","path":"skills/alpha/SKILL.md"},
  {"name":"zeta","description":"Not installed yet","path":"skills/zeta/SKILL.md"}
]
JSON
  start_remaining_ui "$tmp_dir" "$port" "$fixture"

  if wait_for_port "$port"; then
    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/external/preview" \
      '{"source":"https://github.com/owner-one/repo-one"}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "200" ] \
      && pass "test_external_preview_returns_candidate_rows: returns 200" \
      || fail "test_external_preview_returns_candidate_rows: expected 200, got $code"

    # URL 形式で渡しても owner/repo に正規化される。
    assert_contains "$body" '"owner-one/repo-one"' \
      && pass "test_external_preview_returns_candidate_rows: normalizes the source" \
      || fail "test_external_preview_returns_candidate_rows: normalized source missing"

    assert_contains "$body" '"name":"zeta"' \
      && pass "test_external_preview_returns_candidate_rows: lists the candidate" \
      || fail "test_external_preview_returns_candidate_rows: candidate missing"

    # 既にインストール済みかどうかが state に出る。ここが崩れると二重 install する。
    assert_matches "$body" '"name":"alpha","[^}]*"state":"active"' \
      && pass "test_external_preview_returns_candidate_rows: marks installed candidate active" \
      || fail "test_external_preview_returns_candidate_rows: installed state missing"

    assert_matches "$body" '"name":"zeta","[^}]*"state":"missing"' \
      && pass "test_external_preview_returns_candidate_rows: marks new candidate missing" \
      || fail "test_external_preview_returns_candidate_rows: missing state absent"
  else
    fail "test_external_preview_returns_candidate_rows: server did not start"
  fi
}

test_external_preview_without_candidates_returns_404() {
  echo "Running test_external_preview_without_candidates_returns_404..."
  local port=18911
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  local fixture="$tmp_dir/candidates.json"
  echo '[]' > "$fixture"
  start_remaining_ui "$tmp_dir" "$port" "$fixture"

  if wait_for_port "$port"; then
    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/external/preview" '{"source":"owner-one/repo-one"}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "404" ] \
      && pass "test_external_preview_without_candidates_returns_404: returns 404" \
      || fail "test_external_preview_without_candidates_returns_404: expected 404, got $code"

    assert_contains "$body" 'SKILL.md が見つかりませんでした' \
      && pass "test_external_preview_without_candidates_returns_404: explains why" \
      || fail "test_external_preview_without_candidates_returns_404: reason missing"

  else
    fail "test_external_preview_without_candidates_returns_404: server did not start"
  fi
}

test_external_preview_reports_candidate_lookup_failure() {
  echo "Running test_external_preview_reports_candidate_lookup_failure..."
  local port=18912
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  # 候補取得そのものが失敗するケース（実際は clone 失敗）を、存在しない候補ファイルで再現する。
  start_remaining_ui "$tmp_dir" "$port" "$tmp_dir/missing-candidates.json"

  if wait_for_port "$port"; then
    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/external/preview" '{"source":"owner-one/repo-one"}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "400" ] \
      && pass "test_external_preview_reports_candidate_lookup_failure: returns 400" \
      || fail "test_external_preview_reports_candidate_lookup_failure: expected 400, got $code"

    assert_contains "$body" '候補取得に失敗' \
      && pass "test_external_preview_reports_candidate_lookup_failure: explains the failure" \
      || fail "test_external_preview_reports_candidate_lookup_failure: reason missing"

    # 失敗時も画面を描ける payload を返す（message だけの裸レスポンスにしない）。
    assert_contains "$body" '"rows"' \
      && pass "test_external_preview_reports_candidate_lookup_failure: keeps the page payload" \
      || fail "test_external_preview_reports_candidate_lookup_failure: page payload missing"
  else
    fail "test_external_preview_without_candidates_returns_404: server did not start"
  fi
}

test_external_add_to_deck_registers_without_installing() {
  echo "Running test_external_add_to_deck_registers_without_installing..."
  local port=18913
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  local fixture="$tmp_dir/candidates.json"
  cat > "$fixture" <<'JSON'
[
  {"name":"zeta","description":"Deck only","path":"skills/zeta/SKILL.md"}
]
JSON

  # add script を stub にしておき、呼ばれたら痕跡が残るようにする。
  # 「deckにだけ追加」は install を伴わないので、この痕跡が無いことが仕様。
  local stub="$tmp_dir/skills-add-stub" args_file="$tmp_dir/add-args.txt"
  cat > "$stub" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$MY_SKILLS_ADD_ARGS_FILE"
exit 0
SH
  chmod +x "$stub"

  mkdir -p "$tmp_dir/project-decks"
  cat > "$tmp_dir/project-decks/sample.json" <<'JSON'
{
  "name": "sample",
  "skills": ["alpha"]
}
JSON

  MY_SKILLS_ADD_SCRIPT="$stub" MY_SKILLS_ADD_ARGS_FILE="$args_file" \
    start_remaining_ui "$tmp_dir" "$port" "$fixture"

  if wait_for_port "$port"; then
    local code body
    code=$(post_json "$tmp_dir" "$port" "/api/external/add-to-deck" \
      '{"deck":"sample","source":"owner-one/repo-one","skills":["zeta"]}')
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "200" ] \
      && pass "test_external_add_to_deck_registers_without_installing: returns 200" \
      || fail "test_external_add_to_deck_registers_without_installing: expected 200, got $code"

    assert_contains "$body" 'deckに追加しました: zeta (2 skills)' \
      && pass "test_external_add_to_deck_registers_without_installing: reports the deck size" \
      || fail "test_external_add_to_deck_registers_without_installing: message missing"

    assert_contains "$(cat "$tmp_dir/skills.lock.json")" '"source": "owner-one/repo-one"' \
      && pass "test_external_add_to_deck_registers_without_installing: records the lock entry" \
      || fail "test_external_add_to_deck_registers_without_installing: lock entry missing"

    assert_contains "$(cat "$tmp_dir/project-decks/sample.json")" '"zeta"' \
      && pass "test_external_add_to_deck_registers_without_installing: adds to the deck" \
      || fail "test_external_add_to_deck_registers_without_installing: deck entry missing"

    [ ! -f "$args_file" ] \
      && pass "test_external_add_to_deck_registers_without_installing: does not install" \
      || fail "test_external_add_to_deck_registers_without_installing: add script was invoked"

    [ ! -e "$tmp_dir/active/zeta" ] \
      && pass "test_external_add_to_deck_registers_without_installing: nothing projected" \
      || fail "test_external_add_to_deck_registers_without_installing: skill was projected"
  else
    fail "test_external_add_to_deck_registers_without_installing: server did not start"
  fi
}

test_external_add_to_deck_rejects_bad_requests() {
  echo "Running test_external_add_to_deck_rejects_bad_requests..."
  local port=18914
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  mkdir -p "$tmp_dir/project-decks"
  cat > "$tmp_dir/project-decks/sample.json" <<'JSON'
{
  "name": "sample",
  "skills": ["alpha"]
}
JSON
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local code body

    code=$(post_json "$tmp_dir" "$port" "/api/external/add-to-deck" \
      '{"deck":"sample","source":"owner-one/repo-one","skills":[]}')
    body=$(cat "$tmp_dir/response.json")
    [ "$code" = "400" ] && assert_contains "$body" 'deckに追加するskillを選択してください' \
      && pass "test_external_add_to_deck_rejects_bad_requests: empty selection returns 400" \
      || fail "test_external_add_to_deck_rejects_bad_requests: empty selection got $code"

    code=$(post_json "$tmp_dir" "$port" "/api/external/add-to-deck" \
      '{"deck":"nonexistent","source":"owner-one/repo-one","skills":["zeta"]}')
    body=$(cat "$tmp_dir/response.json")
    [ "$code" = "400" ] && assert_contains "$body" 'Unknown project deck: nonexistent' \
      && pass "test_external_add_to_deck_rejects_bad_requests: unknown deck returns 400" \
      || fail "test_external_add_to_deck_rejects_bad_requests: unknown deck got $code"

    code=$(post_json "$tmp_dir" "$port" "/api/external/add-to-deck" \
      '{"deck":"sample","source":"not a repo","skills":["zeta"]}')
    [ "$code" = "400" ] \
      && pass "test_external_add_to_deck_rejects_bad_requests: bad source returns 400" \
      || fail "test_external_add_to_deck_rejects_bad_requests: bad source got $code"
  else
    fail "test_external_add_to_deck_rejects_bad_requests: server did not start"
  fi
}

test_ogp_rejects_unparsable_source() {
  echo "Running test_ogp_rejects_unparsable_source..."
  local port=18915
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  start_remaining_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    # owner/repo に正規化できない入力は外部へ出る前に落とす。
    local code body
    code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      "http://localhost:${port}/api/ogp/notarepo" 2>/dev/null || echo "000")
    body=$(cat "$tmp_dir/response.json")

    [ "$code" = "400" ] \
      && pass "test_ogp_rejects_unparsable_source: returns 400" \
      || fail "test_ogp_rejects_unparsable_source: expected 400, got $code"

    assert_contains "$body" '"message"' \
      && pass "test_ogp_rejects_unparsable_source: returns a message" \
      || fail "test_ogp_rejects_unparsable_source: message missing"
  else
    fail "test_ogp_rejects_unparsable_source: server did not start"
  fi
}

register_cases \
  test_bulk_off_turns_off_every_managed_active_skill \
  test_bulk_off_without_active_returns_400 \
  test_custom_check_updates_reports_drifted_skills \
  test_custom_check_updates_reports_up_to_date \
  test_custom_update_overwrites_installed_copy_from_repo \
  test_custom_update_reads_source_from_selected_catalog \
  test_custom_update_rejects_bad_requests \
  test_custom_update_all_updates_every_drifted_skill \
  test_custom_update_all_rejects_bad_requests \
  test_external_sources_groups_skills_by_repo \
  test_external_preview_returns_candidate_rows \
  test_external_preview_without_candidates_returns_404 \
  test_external_preview_reports_candidate_lookup_failure \
  test_external_add_to_deck_registers_without_installing \
  test_external_add_to_deck_rejects_bad_requests \
  test_ogp_rejects_unparsable_source
