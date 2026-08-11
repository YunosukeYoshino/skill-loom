# Preset の HTTP seam（save / apply / restore / delete / preview）
#
# preset は保存先が ~/.agents/skill-presets のため、サンドボックスを 1 つでも
# 外すと開発者本人の preset が消える。UI の起動は必ず start_preset_ui() 経由にし、
# MY_SKILLS_PRESETS_DIR を含めた全サンドボックス変数を渡すこと。

# fixtures.sh の start_projection_ui に MY_SKILLS_PRESETS_DIR を足したもの。
# 共有 fixture を書き換えずに preset の保存先だけ tmp へ閉じ込める。
start_preset_ui() {
  local tmp_dir="$1" port="$2"
  mkdir -p "$tmp_dir/presets"
  MY_SKILLS_LOCK_FILE="$tmp_dir/skills.lock.json" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" \
    MY_SKILLS_PRESETS_DIR="$tmp_dir/presets" \
    ./my-skills ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2
}

# サブシェルだと TMP_DIRS への追記が消えるので、戻り値ではなくグローバルへ書く。
preset_sandbox() {
  PRESET_TMP_DIR=$(mktemp -d)
  TMP_DIRS+=("$PRESET_TMP_DIR")
  setup_projection_fixture "$PRESET_TMP_DIR"
  mkdir -p "$PRESET_TMP_DIR/presets"
}

write_preset_fixture() {
  local tmp_dir="$1" name="$2" body="$3"
  mkdir -p "$tmp_dir/presets"
  printf '%s\n' "$body" > "$tmp_dir/presets/${name}.json"
}

post_preset() {
  local tmp_dir="$1" port="$2" route="$3" body="$4"
  curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
    -X POST "http://localhost:${port}/api/presets/${route}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null || echo "000"
}

get_preset_preview() {
  local tmp_dir="$1" port="$2" name="$3"
  curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
    "http://localhost:${port}/api/presets/${name}/preview" 2>/dev/null || echo "000"
}

preset_response() {
  cat "$1/response.json"
}

# CLI 版 preset。UI と同じサンドボックスで動かし、終了コードを標準出力へ返す。
# 標準出力と標準エラーはファイルへ落とし、呼び出し側が個別に読む。
run_preset_cli() {
  local tmp_dir="$1"
  shift
  mkdir -p "$tmp_dir/presets"
  MY_SKILLS_LOCK_FILE="$tmp_dir/skills.lock.json" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" \
    MY_SKILLS_PRESETS_DIR="$tmp_dir/presets" \
    ./my-skills preset "$@" > "$tmp_dir/cli-stdout.txt" 2> "$tmp_dir/cli-stderr.txt" \
    && echo 0 || echo $?
}

# beta を archive へ落とした状態を作る。CLI テストは UI を立てないので手で置く。
archive_beta() {
  local tmp_dir="$1"
  mv "$tmp_dir/active/beta" "$tmp_dir/archive/beta"
  rm -f "$tmp_dir/claude-skills/beta" "$tmp_dir/gemini-skills/beta"
}

test_preset_sandbox_isolates_home_presets() {
  echo "Running test_preset_sandbox_isolates_home_presets..."
  local port=18860
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  local home_presets="$HOME/.agents/skill-presets"
  local home_before
  home_before=$(ls -A "$home_presets" 2>/dev/null | sort || true)
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_preset "$tmp_dir" "$port" save '{"name":"sandbox-check"}')

    [ "$http_code" = "200" ] \
      && pass "test_preset_sandbox_isolates_home_presets: HTTP 200" \
      || fail "test_preset_sandbox_isolates_home_presets: got HTTP $http_code"

    [ -f "$tmp_dir/presets/sandbox-check.json" ] \
      && pass "test_preset_sandbox_isolates_home_presets: written into the sandbox" \
      || fail "test_preset_sandbox_isolates_home_presets: sandbox preset missing"

    [ ! -e "$home_presets/sandbox-check.json" ] \
      && pass "test_preset_sandbox_isolates_home_presets: real home untouched" \
      || fail "test_preset_sandbox_isolates_home_presets: wrote into the real home presets"

    local home_after
    home_after=$(ls -A "$home_presets" 2>/dev/null | sort || true)
    [ "$home_before" = "$home_after" ] \
      && pass "test_preset_sandbox_isolates_home_presets: home preset listing unchanged" \
      || fail "test_preset_sandbox_isolates_home_presets: home preset listing changed"

    # 一覧がサンドボックスだけを見ている証拠（本物の preset が混ざらない）。
    assert_matches "$(preset_response "$tmp_dir")" '"presets":\[\{"name":"sandbox-check"' \
      && pass "test_preset_sandbox_isolates_home_presets: lists only sandbox presets" \
      || fail "test_preset_sandbox_isolates_home_presets: preset list leaked from home"
  else
    fail "test_preset_sandbox_isolates_home_presets: server did not start"
  fi
}

test_preset_save_persists_active_set() {
  echo "Running test_preset_save_persists_active_set..."
  local port=18861
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_preset "$tmp_dir" "$port" save '{"name":"work","description":"work set"}')
    local json
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "200" ] \
      && pass "test_preset_save_persists_active_set: HTTP 200" \
      || fail "test_preset_save_persists_active_set: got HTTP $http_code"

    assert_contains "$json" '"message":"Saved preset: work (2 skills)"' \
      && pass "test_preset_save_persists_active_set: summary message" \
      || fail "test_preset_save_persists_active_set: message wrong"

    local saved
    saved=$(cat "$tmp_dir/presets/work.json")

    assert_matches "$saved" '"skills": \[' \
      && pass "test_preset_save_persists_active_set: preset file written" \
      || fail "test_preset_save_persists_active_set: preset file malformed"

    assert_contains "$saved" '"alpha"' && assert_contains "$saved" '"beta"' \
      && pass "test_preset_save_persists_active_set: snapshots the active set" \
      || fail "test_preset_save_persists_active_set: active set missing"

    assert_contains "$saved" '"description": "work set"' \
      && pass "test_preset_save_persists_active_set: keeps description" \
      || fail "test_preset_save_persists_active_set: description missing"

    assert_matches "$json" '"name":"work","description":"work set","skillCount":2' \
      && pass "test_preset_save_persists_active_set: payload lists the preset" \
      || fail "test_preset_save_persists_active_set: payload preset row wrong"

    assert_contains "$json" '"hasPreviousPreset":false' \
      && pass "test_preset_save_persists_active_set: save does not create a restore point" \
      || fail "test_preset_save_persists_active_set: unexpected previous state"
  else
    fail "test_preset_save_persists_active_set: server did not start"
  fi
}

test_preset_save_rejects_invalid_requests() {
  echo "Running test_preset_save_rejects_invalid_requests..."
  local port=18862
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_preset "$tmp_dir" "$port" save '{}')
    [ "$http_code" = "400" ] && assert_contains "$(preset_response "$tmp_dir")" "Preset name is required" \
      && pass "test_preset_save_rejects_invalid_requests: empty name 400" \
      || fail "test_preset_save_rejects_invalid_requests: empty name got HTTP $http_code"

    http_code=$(post_preset "$tmp_dir" "$port" save '{"name":"Bad Name"}')
    [ "$http_code" = "400" ] && assert_contains "$(preset_response "$tmp_dir")" "Invalid preset name" \
      && pass "test_preset_save_rejects_invalid_requests: invalid name 400" \
      || fail "test_preset_save_rejects_invalid_requests: invalid name got HTTP $http_code"

    http_code=$(post_preset "$tmp_dir" "$port" save '{"name":"_last"}')
    [ "$http_code" = "400" ] && assert_contains "$(preset_response "$tmp_dir")" "Reserved preset name: _last" \
      && pass "test_preset_save_rejects_invalid_requests: reserved name 400" \
      || fail "test_preset_save_rejects_invalid_requests: reserved name got HTTP $http_code"

    http_code=$(post_preset "$tmp_dir" "$port" save '{"name":"work"}')
    [ "$http_code" = "200" ] \
      && pass "test_preset_save_rejects_invalid_requests: first save 200" \
      || fail "test_preset_save_rejects_invalid_requests: first save got HTTP $http_code"

    http_code=$(post_preset "$tmp_dir" "$port" save '{"name":"work","description":"second"}')
    [ "$http_code" = "409" ] && assert_contains "$(preset_response "$tmp_dir")" "Preset already exists: work" \
      && pass "test_preset_save_rejects_invalid_requests: duplicate 409" \
      || fail "test_preset_save_rejects_invalid_requests: duplicate got HTTP $http_code"

    assert_contains "$(cat "$tmp_dir/presets/work.json")" '"description"' \
      && fail "test_preset_save_rejects_invalid_requests: rejected save overwrote the file" \
      || pass "test_preset_save_rejects_invalid_requests: rejected save left the file intact"

    http_code=$(post_preset "$tmp_dir" "$port" save '{"name":"work","description":"second","overwrite":true}')
    [ "$http_code" = "200" ] \
      && pass "test_preset_save_rejects_invalid_requests: overwrite 200" \
      || fail "test_preset_save_rejects_invalid_requests: overwrite got HTTP $http_code"

    assert_contains "$(cat "$tmp_dir/presets/work.json")" '"description": "second"' \
      && pass "test_preset_save_rejects_invalid_requests: overwrite replaces the file" \
      || fail "test_preset_save_rejects_invalid_requests: overwrite did not replace the file"
  else
    fail "test_preset_save_rejects_invalid_requests: server did not start"
  fi
}

test_preset_save_without_active_returns_400() {
  echo "Running test_preset_save_without_active_returns_400..."
  local port=18863
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  rm -rf "$tmp_dir/active/alpha" "$tmp_dir/active/beta"
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_preset "$tmp_dir" "$port" save '{"name":"empty"}')

    [ "$http_code" = "400" ] \
      && pass "test_preset_save_without_active_returns_400: HTTP 400" \
      || fail "test_preset_save_without_active_returns_400: got HTTP $http_code"

    assert_contains "$(preset_response "$tmp_dir")" "Cannot save preset: no active skills" \
      && pass "test_preset_save_without_active_returns_400: message shown" \
      || fail "test_preset_save_without_active_returns_400: message missing"

    [ ! -e "$tmp_dir/presets/empty.json" ] \
      && pass "test_preset_save_without_active_returns_400: no preset file written" \
      || fail "test_preset_save_without_active_returns_400: empty preset written"
  else
    fail "test_preset_save_without_active_returns_400: server did not start"
  fi
}

test_preset_preview_returns_plan() {
  echo "Running test_preset_preview_returns_plan..."
  local port=18864
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  write_preset_fixture "$tmp_dir" only-alpha \
    '{"name":"only-alpha","description":"alpha only","skills":["alpha"]}'
  write_preset_fixture "$tmp_dir" ghosty \
    '{"name":"ghosty","skills":["alpha","ghost"]}'
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code json
    http_code=$(get_preset_preview "$tmp_dir" "$port" only-alpha)
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "200" ] \
      && pass "test_preset_preview_returns_plan: HTTP 200" \
      || fail "test_preset_preview_returns_plan: got HTTP $http_code"

    assert_contains "$json" '"page":"global"' \
      && pass "test_preset_preview_returns_plan: keeps the global payload" \
      || fail "test_preset_preview_returns_plan: base payload missing"

    assert_contains "$json" '"presetPreview":{"name":"only-alpha","description":"alpha only","skills":["alpha"]' \
      && pass "test_preset_preview_returns_plan: echoes preset metadata" \
      || fail "test_preset_preview_returns_plan: preset metadata wrong"

    assert_contains "$json" '"preview":{"active":[],"off":["beta"],"install":[],"unresolved":[]}' \
      && pass "test_preset_preview_returns_plan: beta shown as off" \
      || fail "test_preset_preview_returns_plan: plan wrong"

    assert_contains "$json" '"blocked":false' \
      && pass "test_preset_preview_returns_plan: not blocked" \
      || fail "test_preset_preview_returns_plan: unexpectedly blocked"

    [ -e "$tmp_dir/active/alpha" ] && [ -e "$tmp_dir/active/beta" ] \
      && pass "test_preset_preview_returns_plan: preview does not touch the projection" \
      || fail "test_preset_preview_returns_plan: preview mutated the projection"

    http_code=$(get_preset_preview "$tmp_dir" "$port" ghosty)
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "200" ] \
      && pass "test_preset_preview_returns_plan: unresolved preview HTTP 200" \
      || fail "test_preset_preview_returns_plan: unresolved preview got HTTP $http_code"

    assert_contains "$json" '"unresolved":["ghost"]' && assert_contains "$json" '"blocked":true' \
      && pass "test_preset_preview_returns_plan: unknown skill blocks the preset" \
      || fail "test_preset_preview_returns_plan: unresolved not reported"

    http_code=$(get_preset_preview "$tmp_dir" "$port" missing-one)
    [ "$http_code" = "400" ] && assert_contains "$(preset_response "$tmp_dir")" "Preset not found: missing-one" \
      && pass "test_preset_preview_returns_plan: unknown preset 400" \
      || fail "test_preset_preview_returns_plan: unknown preset got HTTP $http_code"
  else
    fail "test_preset_preview_returns_plan: server did not start"
  fi
}

test_preset_apply_requires_confirm() {
  echo "Running test_preset_apply_requires_confirm..."
  local port=18865
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  write_preset_fixture "$tmp_dir" only-alpha '{"name":"only-alpha","skills":["alpha"]}'
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code json
    http_code=$(post_preset "$tmp_dir" "$port" apply '{"name":"only-alpha"}')
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "200" ] \
      && pass "test_preset_apply_requires_confirm: HTTP 200" \
      || fail "test_preset_apply_requires_confirm: got HTTP $http_code"

    assert_contains "$json" "確認してください" \
      && pass "test_preset_apply_requires_confirm: asks for confirmation" \
      || fail "test_preset_apply_requires_confirm: confirmation prompt missing"

    assert_contains "$json" '"presetPreview"' \
      && pass "test_preset_apply_requires_confirm: returns the preview" \
      || fail "test_preset_apply_requires_confirm: preview missing"

    [ -e "$tmp_dir/active/beta" ] \
      && pass "test_preset_apply_requires_confirm: projection untouched without confirm" \
      || fail "test_preset_apply_requires_confirm: applied without confirmation"

    [ ! -e "$tmp_dir/presets/_last.json" ] \
      && pass "test_preset_apply_requires_confirm: no backup taken without confirm" \
      || fail "test_preset_apply_requires_confirm: backup written without confirmation"
  else
    fail "test_preset_apply_requires_confirm: server did not start"
  fi
}

test_preset_apply_projects_to_all_four_places() {
  echo "Running test_preset_apply_projects_to_all_four_places..."
  local port=18866
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  write_preset_fixture "$tmp_dir" only-alpha '{"name":"only-alpha","skills":["alpha"]}'
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code json
    http_code=$(post_preset "$tmp_dir" "$port" apply '{"name":"only-alpha","confirm":true}')
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "200" ] \
      && pass "test_preset_apply_projects_to_all_four_places: HTTP 200" \
      || fail "test_preset_apply_projects_to_all_four_places: got HTTP $http_code"

    assert_contains "$json" '"message":"Applied preset: only-alpha"' \
      && pass "test_preset_apply_projects_to_all_four_places: apply message" \
      || fail "test_preset_apply_projects_to_all_four_places: message wrong"

    # 1. Active ディレクトリ
    [ -e "$tmp_dir/active/alpha" ] && [ ! -e "$tmp_dir/active/beta" ] \
      && pass "test_preset_apply_projects_to_all_four_places: active matches the preset" \
      || fail "test_preset_apply_projects_to_all_four_places: active dir wrong"

    # 2. Archive ディレクトリ（preset 適用は archive も含めて置き換える）
    [ ! -e "$tmp_dir/archive/beta" ] \
      && pass "test_preset_apply_projects_to_all_four_places: beta not left in archive" \
      || fail "test_preset_apply_projects_to_all_four_places: beta leaked into archive"

    # 3. CLI lock
    local cli_lock
    cli_lock=$(cat "$tmp_dir/.skill-lock.json")
    assert_contains "$cli_lock" '"beta"' \
      && fail "test_preset_apply_projects_to_all_four_places: beta still in the CLI lock" \
      || pass "test_preset_apply_projects_to_all_four_places: beta deregistered from the CLI lock"

    assert_contains "$cli_lock" '"alpha"' \
      && pass "test_preset_apply_projects_to_all_four_places: alpha stays in the CLI lock" \
      || fail "test_preset_apply_projects_to_all_four_places: alpha dropped from the CLI lock"

    # 4. エージェント symlink
    for agent_dir in claude-skills gemini-skills; do
      [ ! -L "$tmp_dir/$agent_dir/beta" ] \
        && pass "test_preset_apply_projects_to_all_four_places: $agent_dir/beta unlinked" \
        || fail "test_preset_apply_projects_to_all_four_places: $agent_dir/beta still linked"

      [ -L "$tmp_dir/$agent_dir/alpha" ] \
        && pass "test_preset_apply_projects_to_all_four_places: $agent_dir/alpha kept" \
        || fail "test_preset_apply_projects_to_all_four_places: $agent_dir/alpha unlinked"
    done

    # Inventory は preset 適用では減らない（ADR 0006 の Off と同じ扱い）。
    assert_contains "$(cat "$tmp_dir/skills.lock.json")" '"beta"' \
      && pass "test_preset_apply_projects_to_all_four_places: inventory keeps beta" \
      || fail "test_preset_apply_projects_to_all_four_places: inventory lost beta"

    assert_contains "$json" '"hasPreviousPreset":true' \
      && pass "test_preset_apply_projects_to_all_four_places: restore point created" \
      || fail "test_preset_apply_projects_to_all_four_places: restore point missing"

    local backup
    backup=$(cat "$tmp_dir/presets/_last.json")
    assert_contains "$backup" '"alpha"' && assert_contains "$backup" '"beta"' \
      && pass "test_preset_apply_projects_to_all_four_places: backup holds the pre-apply active set" \
      || fail "test_preset_apply_projects_to_all_four_places: backup content wrong"
  else
    fail "test_preset_apply_projects_to_all_four_places: server did not start"
  fi
}

test_preset_apply_restores_archived_skill() {
  echo "Running test_preset_apply_restores_archived_skill..."
  local port=18867
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  write_preset_fixture "$tmp_dir" both '{"name":"both","skills":["alpha","beta"]}'
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_apply "$tmp_dir" "$port" '{"states":{"beta":"archive"}}')
    [ "$http_code" = "200" ] && [ -e "$tmp_dir/archive/beta" ] \
      && pass "test_preset_apply_restores_archived_skill: beta archived first" \
      || fail "test_preset_apply_restores_archived_skill: archive setup failed (HTTP $http_code)"

    http_code=$(post_preset "$tmp_dir" "$port" apply '{"name":"both","confirm":true}')
    local json
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "200" ] \
      && pass "test_preset_apply_restores_archived_skill: HTTP 200" \
      || fail "test_preset_apply_restores_archived_skill: got HTTP $http_code"

    [ -e "$tmp_dir/active/beta" ] && [ ! -e "$tmp_dir/archive/beta" ] \
      && pass "test_preset_apply_restores_archived_skill: beta moved back to active" \
      || fail "test_preset_apply_restores_archived_skill: beta not restored"

    [ -e "$tmp_dir/active/alpha" ] \
      && pass "test_preset_apply_restores_archived_skill: alpha stays active" \
      || fail "test_preset_apply_restores_archived_skill: alpha lost"

    for agent_dir in claude-skills gemini-skills; do
      [ -L "$tmp_dir/$agent_dir/beta" ] \
        && pass "test_preset_apply_restores_archived_skill: $agent_dir/beta relinked" \
        || fail "test_preset_apply_restores_archived_skill: $agent_dir/beta not relinked"
    done

    assert_contains "$json" '"message":"Applied preset: both"' \
      && pass "test_preset_apply_restores_archived_skill: apply message" \
      || fail "test_preset_apply_restores_archived_skill: message wrong"

    assert_matches "$json" '"counts":\{"active":2,"off":0,"archive":0' \
      && pass "test_preset_apply_restores_archived_skill: counts refreshed" \
      || fail "test_preset_apply_restores_archived_skill: counts stale or wrong"
  else
    fail "test_preset_apply_restores_archived_skill: server did not start"
  fi
}

test_preset_apply_rejects_unknown_and_unresolved() {
  echo "Running test_preset_apply_rejects_unknown_and_unresolved..."
  local port=18868
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  write_preset_fixture "$tmp_dir" ghosty '{"name":"ghosty","skills":["alpha","ghost"]}'
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_preset "$tmp_dir" "$port" apply '{"confirm":true}')
    [ "$http_code" = "400" ] && assert_contains "$(preset_response "$tmp_dir")" "Preset name is required" \
      && pass "test_preset_apply_rejects_unknown_and_unresolved: empty name 400" \
      || fail "test_preset_apply_rejects_unknown_and_unresolved: empty name got HTTP $http_code"

    http_code=$(post_preset "$tmp_dir" "$port" apply '{"name":"nope","confirm":true}')
    [ "$http_code" = "400" ] && assert_contains "$(preset_response "$tmp_dir")" "Preset not found: nope" \
      && pass "test_preset_apply_rejects_unknown_and_unresolved: unknown preset 400" \
      || fail "test_preset_apply_rejects_unknown_and_unresolved: unknown preset got HTTP $http_code"

    http_code=$(post_preset "$tmp_dir" "$port" apply '{"name":"ghosty","confirm":true}')
    local json
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "400" ] \
      && pass "test_preset_apply_rejects_unknown_and_unresolved: unresolved 400" \
      || fail "test_preset_apply_rejects_unknown_and_unresolved: unresolved got HTTP $http_code"

    assert_contains "$json" '"message":"Unresolved: ghost"' \
      && pass "test_preset_apply_rejects_unknown_and_unresolved: names the unresolved skill" \
      || fail "test_preset_apply_rejects_unknown_and_unresolved: unresolved message wrong"

    assert_contains "$json" '"blocked":true' \
      && pass "test_preset_apply_rejects_unknown_and_unresolved: returns the blocked preview" \
      || fail "test_preset_apply_rejects_unknown_and_unresolved: blocked preview missing"

    [ -e "$tmp_dir/active/alpha" ] && [ -e "$tmp_dir/active/beta" ] \
      && pass "test_preset_apply_rejects_unknown_and_unresolved: projection untouched" \
      || fail "test_preset_apply_rejects_unknown_and_unresolved: partial apply happened"

    [ ! -e "$tmp_dir/presets/_last.json" ] \
      && pass "test_preset_apply_rejects_unknown_and_unresolved: no backup on rejection" \
      || fail "test_preset_apply_rejects_unknown_and_unresolved: backup written on rejection"
  else
    fail "test_preset_apply_rejects_unknown_and_unresolved: server did not start"
  fi
}

test_preset_restore_previous_returns_to_prior_state() {
  echo "Running test_preset_restore_previous_returns_to_prior_state..."
  local port=18869
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  write_preset_fixture "$tmp_dir" both '{"name":"both","skills":["alpha","beta"]}'
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code json
    # 直前の状態 = alpha だけが active（beta は archive）。
    http_code=$(post_apply "$tmp_dir" "$port" '{"states":{"beta":"archive"}}')
    [ "$http_code" = "200" ] \
      && pass "test_preset_restore_previous_returns_to_prior_state: prior state prepared" \
      || fail "test_preset_restore_previous_returns_to_prior_state: setup got HTTP $http_code"

    http_code=$(post_preset "$tmp_dir" "$port" apply '{"name":"both","confirm":true}')
    [ "$http_code" = "200" ] && [ -e "$tmp_dir/active/beta" ] \
      && pass "test_preset_restore_previous_returns_to_prior_state: preset applied" \
      || fail "test_preset_restore_previous_returns_to_prior_state: preset apply got HTTP $http_code"

    http_code=$(post_preset "$tmp_dir" "$port" restore '{}')
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "200" ] \
      && pass "test_preset_restore_previous_returns_to_prior_state: preview HTTP 200" \
      || fail "test_preset_restore_previous_returns_to_prior_state: preview got HTTP $http_code"

    assert_contains "$json" "確認してください" \
      && pass "test_preset_restore_previous_returns_to_prior_state: asks for confirmation" \
      || fail "test_preset_restore_previous_returns_to_prior_state: confirmation prompt missing"

    assert_contains "$json" '"presetPreview":{"name":"_last","description":"","skills":["alpha"]' \
      && pass "test_preset_restore_previous_returns_to_prior_state: previews the prior active set" \
      || fail "test_preset_restore_previous_returns_to_prior_state: preview content wrong"

    [ -e "$tmp_dir/active/beta" ] \
      && pass "test_preset_restore_previous_returns_to_prior_state: nothing restored without confirm" \
      || fail "test_preset_restore_previous_returns_to_prior_state: restored without confirmation"

    http_code=$(post_preset "$tmp_dir" "$port" restore '{"confirm":true}')
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "200" ] \
      && pass "test_preset_restore_previous_returns_to_prior_state: restore HTTP 200" \
      || fail "test_preset_restore_previous_returns_to_prior_state: restore got HTTP $http_code"

    assert_contains "$json" '"message":"Restored previous active set"' \
      && pass "test_preset_restore_previous_returns_to_prior_state: restore message" \
      || fail "test_preset_restore_previous_returns_to_prior_state: restore message wrong"

    [ -e "$tmp_dir/active/alpha" ] && [ ! -e "$tmp_dir/active/beta" ] \
      && pass "test_preset_restore_previous_returns_to_prior_state: back to the prior active set" \
      || fail "test_preset_restore_previous_returns_to_prior_state: prior state not restored"

    assert_contains "$(cat "$tmp_dir/.skill-lock.json")" '"beta"' \
      && fail "test_preset_restore_previous_returns_to_prior_state: beta still in the CLI lock" \
      || pass "test_preset_restore_previous_returns_to_prior_state: beta deregistered from the CLI lock"

    for agent_dir in claude-skills gemini-skills; do
      [ ! -L "$tmp_dir/$agent_dir/beta" ] \
        && pass "test_preset_restore_previous_returns_to_prior_state: $agent_dir/beta unlinked" \
        || fail "test_preset_restore_previous_returns_to_prior_state: $agent_dir/beta still linked"
    done

    # restore は片道ではなく、直前の状態を _last に入れ替える。
    http_code=$(post_preset "$tmp_dir" "$port" restore '{}')
    json=$(preset_response "$tmp_dir")

    assert_contains "$json" '"skills":["alpha","beta"]' \
      && pass "test_preset_restore_previous_returns_to_prior_state: restore point swapped to the applied set" \
      || fail "test_preset_restore_previous_returns_to_prior_state: restore point not swapped"
  else
    fail "test_preset_restore_previous_returns_to_prior_state: server did not start"
  fi
}

test_preset_restore_without_previous_returns_400() {
  echo "Running test_preset_restore_without_previous_returns_400..."
  local port=18870
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code json
    http_code=$(post_preset "$tmp_dir" "$port" restore '{"confirm":true}')
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "400" ] \
      && pass "test_preset_restore_without_previous_returns_400: HTTP 400" \
      || fail "test_preset_restore_without_previous_returns_400: got HTTP $http_code"

    assert_contains "$json" "No previous state saved" \
      && pass "test_preset_restore_without_previous_returns_400: message shown" \
      || fail "test_preset_restore_without_previous_returns_400: message missing"

    assert_contains "$json" '"hasPreviousPreset":false' \
      && pass "test_preset_restore_without_previous_returns_400: no restore point advertised" \
      || fail "test_preset_restore_without_previous_returns_400: restore point advertised"

    [ -e "$tmp_dir/active/alpha" ] && [ -e "$tmp_dir/active/beta" ] \
      && pass "test_preset_restore_without_previous_returns_400: projection untouched" \
      || fail "test_preset_restore_without_previous_returns_400: projection mutated"
  else
    fail "test_preset_restore_without_previous_returns_400: server did not start"
  fi
}

test_preset_delete_removes_preset() {
  echo "Running test_preset_delete_removes_preset..."
  local port=18871
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  write_preset_fixture "$tmp_dir" work '{"name":"work","skills":["alpha"]}'
  write_preset_fixture "$tmp_dir" _last '{"name":"_last","skills":["alpha","beta"]}'
  start_preset_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code json
    http_code=$(post_preset "$tmp_dir" "$port" delete '{}')
    [ "$http_code" = "400" ] && assert_contains "$(preset_response "$tmp_dir")" "Preset name is required" \
      && pass "test_preset_delete_removes_preset: empty name 400" \
      || fail "test_preset_delete_removes_preset: empty name got HTTP $http_code"

    http_code=$(post_preset "$tmp_dir" "$port" delete '{"name":"_last"}')
    [ "$http_code" = "400" ] && assert_contains "$(preset_response "$tmp_dir")" "Reserved preset name: _last" \
      && pass "test_preset_delete_removes_preset: reserved name 400" \
      || fail "test_preset_delete_removes_preset: reserved name got HTTP $http_code"

    [ -f "$tmp_dir/presets/_last.json" ] \
      && pass "test_preset_delete_removes_preset: restore point survives" \
      || fail "test_preset_delete_removes_preset: restore point deleted"

    http_code=$(post_preset "$tmp_dir" "$port" delete '{"name":"work"}')
    json=$(preset_response "$tmp_dir")

    [ "$http_code" = "200" ] \
      && pass "test_preset_delete_removes_preset: HTTP 200" \
      || fail "test_preset_delete_removes_preset: got HTTP $http_code"

    assert_contains "$json" '"message":"Deleted preset: work"' \
      && pass "test_preset_delete_removes_preset: delete message" \
      || fail "test_preset_delete_removes_preset: message wrong"

    [ ! -e "$tmp_dir/presets/work.json" ] \
      && pass "test_preset_delete_removes_preset: preset file removed" \
      || fail "test_preset_delete_removes_preset: preset file still there"

    assert_contains "$json" '"presets":[]' \
      && pass "test_preset_delete_removes_preset: list refreshed" \
      || fail "test_preset_delete_removes_preset: list stale"

    assert_contains "$json" '"hasPreviousPreset":true' \
      && pass "test_preset_delete_removes_preset: restore point still advertised" \
      || fail "test_preset_delete_removes_preset: restore point lost"

    http_code=$(post_preset "$tmp_dir" "$port" delete '{"name":"work"}')
    [ "$http_code" = "400" ] && assert_contains "$(preset_response "$tmp_dir")" "Preset not found: work" \
      && pass "test_preset_delete_removes_preset: second delete 400" \
      || fail "test_preset_delete_removes_preset: second delete got HTTP $http_code"

    [ -e "$tmp_dir/active/alpha" ] && [ -e "$tmp_dir/active/beta" ] \
      && pass "test_preset_delete_removes_preset: delete does not touch the projection" \
      || fail "test_preset_delete_removes_preset: delete mutated the projection"
  else
    fail "test_preset_delete_removes_preset: server did not start"
  fi
}

test_preset_cli_lists_and_saves() {
  echo "Running test_preset_cli_lists_and_saves..."
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  local status

  status=$(run_preset_cli "$tmp_dir" list)
  [ "$status" = "0" ] && [ "$(cat "$tmp_dir/cli-stdout.txt")" = "No presets." ] \
    && pass "test_preset_cli_lists_and_saves: empty list" \
    || fail "test_preset_cli_lists_and_saves: empty list wrong (exit $status)"

  status=$(run_preset_cli "$tmp_dir" save daily --description 普段使い)
  [ "$status" = "0" ] \
    && assert_contains "$(cat "$tmp_dir/cli-stdout.txt")" "Saved preset daily (2 skills)" \
    && pass "test_preset_cli_lists_and_saves: save message" \
    || fail "test_preset_cli_lists_and_saves: save got exit $status"

  status=$(run_preset_cli "$tmp_dir" list)
  # 桁揃えは移行前の f-string のまま（name 24 桁・件数 3 桁）。
  assert_matches "$(cat "$tmp_dir/cli-stdout.txt")" '^daily +2  普段使い$' \
    && pass "test_preset_cli_lists_and_saves: list line format" \
    || fail "test_preset_cli_lists_and_saves: list line format wrong"

  status=$(run_preset_cli "$tmp_dir" save daily)
  [ "$status" = "2" ] \
    && assert_contains "$(cat "$tmp_dir/cli-stderr.txt")" "Preset already exists: daily" \
    && pass "test_preset_cli_lists_and_saves: duplicate rejected" \
    || fail "test_preset_cli_lists_and_saves: duplicate got exit $status"

  status=$(run_preset_cli "$tmp_dir" save _last)
  [ "$status" = "2" ] \
    && assert_contains "$(cat "$tmp_dir/cli-stderr.txt")" "Reserved preset name: _last" \
    && pass "test_preset_cli_lists_and_saves: reserved name rejected" \
    || fail "test_preset_cli_lists_and_saves: reserved name got exit $status"
}

test_preset_cli_apply_and_restore_round_trip() {
  echo "Running test_preset_cli_apply_and_restore_round_trip..."
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  local status
  write_preset_fixture "$tmp_dir" both '{"name":"both","skills":["alpha","beta"]}'
  archive_beta "$tmp_dir"

  status=$(run_preset_cli "$tmp_dir" apply both -y)
  [ "$status" = "0" ] && [ -e "$tmp_dir/active/beta" ] \
    && assert_contains "$(cat "$tmp_dir/cli-stdout.txt")" "Applied preset: both" \
    && pass "test_preset_cli_apply_and_restore_round_trip: applied" \
    || fail "test_preset_cli_apply_and_restore_round_trip: apply got exit $status"

  [ -L "$tmp_dir/claude-skills/beta" ] && [ -L "$tmp_dir/gemini-skills/beta" ] \
    && pass "test_preset_cli_apply_and_restore_round_trip: agent symlinks restored" \
    || fail "test_preset_cli_apply_and_restore_round_trip: agent symlinks missing"

  status=$(run_preset_cli "$tmp_dir" restore -y)
  [ "$status" = "0" ] && [ -e "$tmp_dir/active/alpha" ] && [ ! -e "$tmp_dir/active/beta" ] \
    && pass "test_preset_cli_apply_and_restore_round_trip: restored to the prior set" \
    || fail "test_preset_cli_apply_and_restore_round_trip: restore got exit $status"

  assert_contains "$(cat "$tmp_dir/.skill-lock.json")" '"beta"' \
    && fail "test_preset_cli_apply_and_restore_round_trip: beta still in the CLI lock" \
    || pass "test_preset_cli_apply_and_restore_round_trip: beta deregistered from the CLI lock"

  # 確認プロンプトで n と答えたら何も動かさず 1 で抜ける。
  status=$(printf 'n\n' | run_preset_cli "$tmp_dir" restore)
  [ "$status" = "1" ] \
    && assert_contains "$(cat "$tmp_dir/cli-stdout.txt")" "Aborted." \
    && [ ! -e "$tmp_dir/active/beta" ] \
    && pass "test_preset_cli_apply_and_restore_round_trip: declining aborts" \
    || fail "test_preset_cli_apply_and_restore_round_trip: decline got exit $status"

  # restore は片道ではないので、_last は「戻す前の状態」に入れ替わっている。
  assert_contains "$(cat "$tmp_dir/presets/_last.json")" '"beta"' \
    && pass "test_preset_cli_apply_and_restore_round_trip: restore point swapped" \
    || fail "test_preset_cli_apply_and_restore_round_trip: restore point not swapped"
}

test_preset_cli_apply_blocks_on_unresolved() {
  echo "Running test_preset_cli_apply_blocks_on_unresolved..."
  preset_sandbox
  local tmp_dir="$PRESET_TMP_DIR"
  local status
  write_preset_fixture "$tmp_dir" ghosty '{"name":"ghosty","skills":["alpha","ghost"]}'

  status=$(run_preset_cli "$tmp_dir" apply ghosty -y)
  [ "$status" = "2" ] \
    && assert_contains "$(cat "$tmp_dir/cli-stdout.txt")" "unresolved (1): ghost" \
    && pass "test_preset_cli_apply_blocks_on_unresolved: blocked with the plan shown" \
    || fail "test_preset_cli_apply_blocks_on_unresolved: got exit $status"

  # 1 つでも解決できなければ 1 バイトも書かない。
  [ -e "$tmp_dir/active/alpha" ] && [ -e "$tmp_dir/active/beta" ] && [ ! -e "$tmp_dir/presets/_last.json" ] \
    && pass "test_preset_cli_apply_blocks_on_unresolved: projection untouched" \
    || fail "test_preset_cli_apply_blocks_on_unresolved: projection mutated"

  status=$(run_preset_cli "$tmp_dir" apply missing-one -y)
  [ "$status" = "2" ] \
    && assert_contains "$(cat "$tmp_dir/cli-stderr.txt")" "Preset not found: missing-one" \
    && pass "test_preset_cli_apply_blocks_on_unresolved: unknown preset rejected" \
    || fail "test_preset_cli_apply_blocks_on_unresolved: unknown preset got exit $status"
}

register_cases \
  test_preset_sandbox_isolates_home_presets \
  test_preset_save_persists_active_set \
  test_preset_save_rejects_invalid_requests \
  test_preset_save_without_active_returns_400 \
  test_preset_preview_returns_plan \
  test_preset_apply_requires_confirm \
  test_preset_apply_projects_to_all_four_places \
  test_preset_apply_restores_archived_skill \
  test_preset_apply_rejects_unknown_and_unresolved \
  test_preset_restore_previous_returns_to_prior_state \
  test_preset_restore_without_previous_returns_400 \
  test_preset_delete_removes_preset \
  test_preset_cli_lists_and_saves \
  test_preset_cli_apply_and_restore_round_trip \
  test_preset_cli_apply_blocks_on_unresolved
