# Projection の書き込み経路（Apply / delta 計算）

test_global_apply_posts_tristate_changes() {
  echo "Running test_global_apply_posts_tristate_changes..."
  local port=18812
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local lock_file="$tmp_dir/skills.lock.json"
  local active_dir="$tmp_dir/active"
  local archive_dir="$tmp_dir/archive"
  mkdir -p "$active_dir" "$archive_dir"
  (cd "$active_dir" && mkdir alpha)

  cat > "$lock_file" <<'JSON'
{
  "version": 1,
  "custom": {
    "repo": "owner/catalog",
    "skills": {
      "alpha": {"repoPath": "skills/a/alpha", "category": "a"},
      "beta": {"repoPath": "skills/b/beta", "category": "b"}
    }
  },
  "external": {},
  "vendor": {}
}
JSON

  MY_SKILLS_LOCK_FILE="$lock_file" \
    MY_SKILLS_ACTIVE_DIR="$active_dir" MY_SKILLS_ARCHIVE_DIR="$archive_dir" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/apply" \
      -H "Content-Type: application/json" \
      -d '{"states":{"alpha":"archive","beta":"off"}}' 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_posts_tristate_changes: HTTP 200" \
      || fail "test_global_apply_posts_tristate_changes: got HTTP $http_code"

    [ ! -e "$active_dir/alpha" ] \
      && pass "test_global_apply_posts_tristate_changes: moved alpha to archive" \
      || fail "test_global_apply_posts_tristate_changes: alpha still active"

    [ -e "$archive_dir/alpha" ] \
      && pass "test_global_apply_posts_tristate_changes: alpha archived" \
      || fail "test_global_apply_posts_tristate_changes: alpha not archived"
  else
    fail "test_global_apply_posts_tristate_changes: server did not start"
  fi
}

test_global_apply_restore_archived_skill() {
  echo "Running test_global_apply_restore_archived_skill..."
  local port=18808
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local lock_file="$tmp_dir/skills.lock.json"
  local active_dir="$tmp_dir/active"
  local archive_dir="$tmp_dir/archive"
  mkdir -p "$active_dir" "$archive_dir"
  (cd "$archive_dir" && mkdir beta)

  cat > "$lock_file" <<'JSON'
{
  "version": 1,
  "custom": {
    "repo": "owner/catalog",
    "skills": {
      "beta": {"repoPath": "skills/b/beta", "category": "b"}
    }
  },
  "external": {},
  "vendor": {}
}
JSON

  MY_SKILLS_LOCK_FILE="$lock_file" \
    MY_SKILLS_ACTIVE_DIR="$active_dir" MY_SKILLS_ARCHIVE_DIR="$archive_dir" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/apply" \
      -H "Content-Type: application/json" \
      -d '{"states":{"beta":"active"}}' 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_restore_archived_skill: HTTP 200" \
      || fail "test_global_apply_restore_archived_skill: got HTTP $http_code"

    [ -e "$active_dir/beta" ] \
      && pass "test_global_apply_restore_archived_skill: restored to active" \
      || fail "test_global_apply_restore_archived_skill: beta not active"

    [ ! -e "$archive_dir/beta" ] \
      && pass "test_global_apply_restore_archived_skill: removed from archive" \
      || fail "test_global_apply_restore_archived_skill: beta still archived"
  else
    fail "test_global_apply_restore_archived_skill: server did not start"
  fi
}

test_global_apply_remove_active_skill() {
  echo "Running test_global_apply_remove_active_skill..."
  local port=18809
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local lock_file="$tmp_dir/skills.lock.json"
  local active_dir="$tmp_dir/active"
  local archive_dir="$tmp_dir/archive"
  mkdir -p "$active_dir" "$archive_dir"
  (cd "$active_dir" && mkdir alpha)

  cat > "$lock_file" <<'JSON'
{
  "version": 1,
  "custom": {
    "repo": "owner/catalog",
    "skills": {
      "alpha": {"repoPath": "skills/a/alpha", "category": "a"}
    }
  },
  "external": {},
  "vendor": {}
}
JSON

  MY_SKILLS_LOCK_FILE="$lock_file" \
    MY_SKILLS_ACTIVE_DIR="$active_dir" MY_SKILLS_ARCHIVE_DIR="$archive_dir" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/apply" \
      -H "Content-Type: application/json" \
      -d '{"states":{"alpha":"off"}}' 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_remove_active_skill: HTTP 200" \
      || fail "test_global_apply_remove_active_skill: got HTTP $http_code"

    [ ! -e "$active_dir/alpha" ] \
      && pass "test_global_apply_remove_active_skill: removed from active" \
      || fail "test_global_apply_remove_active_skill: alpha still active"
  else
    fail "test_global_apply_remove_active_skill: server did not start"
  fi
}

test_global_apply_single_off_leaves_other_active_skills() {
  echo "Running test_global_apply_single_off_leaves_other_active_skills..."
  local port=18810
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local lock_file="$tmp_dir/skills.lock.json"
  local active_dir="$tmp_dir/active"
  local archive_dir="$tmp_dir/archive"
  mkdir -p "$active_dir" "$archive_dir"
  for skill in codex copywriting difit frontend-design shadcn skill-auditor; do
    (cd "$active_dir" && mkdir "$skill")
  done

  cat > "$lock_file" <<'JSON'
{
  "version": 1,
  "custom": {
    "repo": "owner/catalog",
    "skills": {
      "codex": {"repoPath": "skills/x/codex", "category": "x"},
      "copywriting": {"repoPath": "skills/x/copywriting", "category": "x"},
      "difit": {"repoPath": "skills/x/difit", "category": "x"},
      "frontend-design": {"repoPath": "skills/x/frontend-design", "category": "x"},
      "shadcn": {"repoPath": "skills/x/shadcn", "category": "x"},
      "skill-auditor": {"repoPath": "skills/x/skill-auditor", "category": "x"}
    }
  },
  "external": {},
  "vendor": {}
}
JSON

  MY_SKILLS_LOCK_FILE="$lock_file" \
    MY_SKILLS_ACTIVE_DIR="$active_dir" MY_SKILLS_ARCHIVE_DIR="$archive_dir" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/apply" \
      -H "Content-Type: application/json" \
      -d '{"states":{"codex":"off"}}' 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_single_off_leaves_other_active_skills: HTTP 200" \
      || fail "test_global_apply_single_off_leaves_other_active_skills: got HTTP $http_code"

    [ ! -e "$active_dir/codex" ] \
      && pass "test_global_apply_single_off_leaves_other_active_skills: codex removed" \
      || fail "test_global_apply_single_off_leaves_other_active_skills: codex still active"

    for skill in copywriting difit frontend-design shadcn skill-auditor; do
      [ -e "$active_dir/$skill" ] \
        && pass "test_global_apply_single_off_leaves_other_active_skills: $skill stays active" \
        || fail "test_global_apply_single_off_leaves_other_active_skills: $skill removed unexpectedly"
    done

    assert_contains "$(cat "$tmp_dir/response.json")" "off(除去) 1: codex" \
      && pass "test_global_apply_single_off_leaves_other_active_skills: summary only codex" \
      || fail "test_global_apply_single_off_leaves_other_active_skills: summary wrong"

    if grep -q "有効化\|新規追加\|復帰" "$tmp_dir/response.json"; then
      fail "test_global_apply_single_off_leaves_other_active_skills: spurious activate in summary"
    else
      pass "test_global_apply_single_off_leaves_other_active_skills: no spurious activate in summary"
    fi
  else
    fail "test_global_apply_single_off_leaves_other_active_skills: server did not start"
  fi
}

test_global_apply_empty_submission_returns_400() {
  echo "Running test_global_apply_empty_submission_returns_400..."
  local port=18811
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local lock_file="$tmp_dir/skills.lock.json"
  local active_dir="$tmp_dir/active"
  local archive_dir="$tmp_dir/archive"
  mkdir -p "$active_dir" "$archive_dir"

  cat > "$lock_file" <<'JSON'
{
  "version": 1,
  "custom": {
    "repo": "owner/catalog",
    "skills": {
      "alpha": {"repoPath": "skills/a/alpha", "category": "a"}
    }
  },
  "external": {},
  "vendor": {}
}
JSON

  MY_SKILLS_LOCK_FILE="$lock_file" \
    MY_SKILLS_ACTIVE_DIR="$active_dir" MY_SKILLS_ARCHIVE_DIR="$archive_dir" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/apply" \
      -H "Content-Type: application/json" \
      -d '{}' 2>/dev/null || echo "000")

    [ "$http_code" = "400" ] \
      && pass "test_global_apply_empty_submission_returns_400: HTTP 400" \
      || fail "test_global_apply_empty_submission_returns_400: got HTTP $http_code"

    assert_contains "$(cat "$tmp_dir/response.json")" "変更がありません" \
      && pass "test_global_apply_empty_submission_returns_400: message shown" \
      || fail "test_global_apply_empty_submission_returns_400: message missing"
  else
    fail "test_global_apply_empty_submission_returns_400: server did not start"
  fi
}

test_global_apply_off_deregisters_from_cli_lock() {
  echo "Running test_global_apply_off_deregisters_from_cli_lock..."
  local port=18815
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  start_projection_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_apply "$tmp_dir" "$port" '{"states":{"alpha":"off"}}')

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_off_deregisters_from_cli_lock: HTTP 200" \
      || fail "test_global_apply_off_deregisters_from_cli_lock: got HTTP $http_code"

    local cli_lock
    cli_lock=$(cat "$tmp_dir/.skill-lock.json")

    assert_contains "$cli_lock" '"alpha"' \
      && fail "test_global_apply_off_deregisters_from_cli_lock: alpha still tracked" \
      || pass "test_global_apply_off_deregisters_from_cli_lock: alpha deregistered"

    assert_contains "$cli_lock" '"beta"' \
      && pass "test_global_apply_off_deregisters_from_cli_lock: beta stays tracked" \
      || fail "test_global_apply_off_deregisters_from_cli_lock: beta dropped"

    assert_contains "$cli_lock" '"version"' \
      && pass "test_global_apply_off_deregisters_from_cli_lock: version key kept" \
      || fail "test_global_apply_off_deregisters_from_cli_lock: version key lost"

    assert_contains "$cli_lock" '"dismissed"' \
      && pass "test_global_apply_off_deregisters_from_cli_lock: unknown top-level key kept" \
      || fail "test_global_apply_off_deregisters_from_cli_lock: unknown top-level key lost"
  else
    fail "test_global_apply_off_deregisters_from_cli_lock: server did not start"
  fi
}

test_global_apply_off_unlinks_agent_skill_dirs() {
  echo "Running test_global_apply_off_unlinks_agent_skill_dirs..."
  local port=18816
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  start_projection_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_apply "$tmp_dir" "$port" '{"states":{"alpha":"off"}}')

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_off_unlinks_agent_skill_dirs: HTTP 200" \
      || fail "test_global_apply_off_unlinks_agent_skill_dirs: got HTTP $http_code"

    for agent_dir in claude-skills gemini-skills; do
      [ ! -L "$tmp_dir/$agent_dir/alpha" ] \
        && pass "test_global_apply_off_unlinks_agent_skill_dirs: $agent_dir/alpha unlinked" \
        || fail "test_global_apply_off_unlinks_agent_skill_dirs: $agent_dir/alpha still linked"

      [ -L "$tmp_dir/$agent_dir/beta" ] \
        && pass "test_global_apply_off_unlinks_agent_skill_dirs: $agent_dir/beta kept" \
        || fail "test_global_apply_off_unlinks_agent_skill_dirs: $agent_dir/beta unlinked"
    done
  else
    fail "test_global_apply_off_unlinks_agent_skill_dirs: server did not start"
  fi
}

test_global_apply_archive_deregisters_and_unlinks() {
  echo "Running test_global_apply_archive_deregisters_and_unlinks..."
  local port=18817
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  start_projection_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_apply "$tmp_dir" "$port" '{"states":{"alpha":"archive"}}')

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_archive_deregisters_and_unlinks: HTTP 200" \
      || fail "test_global_apply_archive_deregisters_and_unlinks: got HTTP $http_code"

    [ -e "$tmp_dir/archive/alpha" ] && [ ! -e "$tmp_dir/active/alpha" ] \
      && pass "test_global_apply_archive_deregisters_and_unlinks: moved to archive" \
      || fail "test_global_apply_archive_deregisters_and_unlinks: alpha not archived"

    assert_contains "$(cat "$tmp_dir/.skill-lock.json")" '"alpha"' \
      && fail "test_global_apply_archive_deregisters_and_unlinks: alpha still tracked" \
      || pass "test_global_apply_archive_deregisters_and_unlinks: alpha deregistered"

    for agent_dir in claude-skills gemini-skills; do
      [ ! -L "$tmp_dir/$agent_dir/alpha" ] \
        && pass "test_global_apply_archive_deregisters_and_unlinks: $agent_dir/alpha unlinked" \
        || fail "test_global_apply_archive_deregisters_and_unlinks: $agent_dir/alpha still linked"
    done
  else
    fail "test_global_apply_archive_deregisters_and_unlinks: server did not start"
  fi
}

test_global_apply_off_keeps_real_agent_directory() {
  echo "Running test_global_apply_off_keeps_real_agent_directory..."
  local port=18818
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  rm "$tmp_dir/claude-skills/alpha"
  mkdir "$tmp_dir/claude-skills/alpha"
  echo "bundled" > "$tmp_dir/claude-skills/alpha/SKILL.md"
  start_projection_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_apply "$tmp_dir" "$port" '{"states":{"alpha":"off"}}')

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_off_keeps_real_agent_directory: HTTP 200" \
      || fail "test_global_apply_off_keeps_real_agent_directory: got HTTP $http_code"

    [ -d "$tmp_dir/claude-skills/alpha" ] && [ ! -L "$tmp_dir/claude-skills/alpha" ] \
      && pass "test_global_apply_off_keeps_real_agent_directory: real directory untouched" \
      || fail "test_global_apply_off_keeps_real_agent_directory: real directory removed"
  else
    fail "test_global_apply_off_keeps_real_agent_directory: server did not start"
  fi
}

test_global_apply_survives_broken_cli_lock() {
  echo "Running test_global_apply_survives_broken_cli_lock..."
  local port=18819
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  echo '{ this is not json' > "$tmp_dir/.skill-lock.json"
  start_projection_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_apply "$tmp_dir" "$port" '{"states":{"alpha":"off"}}')

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_survives_broken_cli_lock: HTTP 200" \
      || fail "test_global_apply_survives_broken_cli_lock: got HTTP $http_code"

    [ ! -e "$tmp_dir/active/alpha" ] \
      && pass "test_global_apply_survives_broken_cli_lock: alpha removed from active" \
      || fail "test_global_apply_survives_broken_cli_lock: alpha still active"

    assert_contains "$(cat "$tmp_dir/response.json")" "CLI lock" \
      && pass "test_global_apply_survives_broken_cli_lock: skip reported in response" \
      || fail "test_global_apply_survives_broken_cli_lock: skip not reported"
  else
    fail "test_global_apply_survives_broken_cli_lock: server did not start"
  fi
}

test_global_apply_without_cli_lock_file() {
  echo "Running test_global_apply_without_cli_lock_file..."
  local port=18820
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  rm "$tmp_dir/.skill-lock.json"
  start_projection_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_apply "$tmp_dir" "$port" '{"states":{"alpha":"off"}}')

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_without_cli_lock_file: HTTP 200" \
      || fail "test_global_apply_without_cli_lock_file: got HTTP $http_code"

    [ ! -e "$tmp_dir/active/alpha" ] \
      && pass "test_global_apply_without_cli_lock_file: alpha removed from active" \
      || fail "test_global_apply_without_cli_lock_file: alpha still active"
  else
    fail "test_global_apply_without_cli_lock_file: server did not start"
  fi
}

test_global_apply_restore_repairs_broken_symlink() {
  echo "Running test_global_apply_restore_repairs_broken_symlink..."
  local port=18821
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"
  # beta archived, with symlinks left dangling at a target that never comes back
  mv "$tmp_dir/active/beta" "$tmp_dir/archive/beta"
  for agent_dir in claude-skills gemini-skills; do
    rm "$tmp_dir/$agent_dir/beta"
    ln -s "$tmp_dir/active/beta-stale" "$tmp_dir/$agent_dir/beta"
  done
  start_projection_ui "$tmp_dir" "$port"

  if wait_for_port "$port"; then
    local http_code
    http_code=$(post_apply "$tmp_dir" "$port" '{"states":{"beta":"active"}}')

    [ "$http_code" = "200" ] \
      && pass "test_global_apply_restore_repairs_broken_symlink: HTTP 200" \
      || fail "test_global_apply_restore_repairs_broken_symlink: got HTTP $http_code"

    for agent_dir in claude-skills gemini-skills; do
      [ -L "$tmp_dir/$agent_dir/beta" ] && [ -e "$tmp_dir/$agent_dir/beta/SKILL.md" ] \
        && pass "test_global_apply_restore_repairs_broken_symlink: $agent_dir/beta resolves" \
        || fail "test_global_apply_restore_repairs_broken_symlink: $agent_dir/beta still dangling"
    done
  else
    fail "test_global_apply_restore_repairs_broken_symlink: server did not start"
  fi
}

test_ui_api_apply_returns_json() {
  echo "Running test_ui_api_apply_returns_json..."
  local port=18881
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local lock_file="$tmp_dir/skills.lock.json"
  local active_dir="$tmp_dir/active"
  local archive_dir="$tmp_dir/archive"
  mkdir -p "$active_dir" "$archive_dir"
  (cd "$active_dir" && mkdir alpha)

  cat > "$lock_file" <<'JSON'
{
  "version": 1,
  "custom": {
    "repo": "owner/catalog",
    "skills": {
      "alpha": {"repoPath": "skills/a/alpha", "category": "a"}
    }
  },
  "external": {},
  "vendor": {}
}
JSON

  MY_SKILLS_LOCK_FILE="$lock_file" \
    MY_SKILLS_ACTIVE_DIR="$active_dir" MY_SKILLS_ARCHIVE_DIR="$archive_dir" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local json
    json=$(curl -s -X POST "http://localhost:${port}/api/apply" \
      -H "Content-Type: application/json" \
      -d '{"states":{"alpha":"archive"}}' 2>/dev/null || true)

    assert_contains "$json" '"page":"global"' \
      && pass "test_ui_api_apply_returns_json: returns global payload" \
      || fail "test_ui_api_apply_returns_json: payload missing"

    assert_contains "$json" '"message"' \
      && pass "test_ui_api_apply_returns_json: has message" \
      || fail "test_ui_api_apply_returns_json: message missing"

    assert_contains "$json" '"archive":1' \
      && pass "test_ui_api_apply_returns_json: refreshes counts" \
      || fail "test_ui_api_apply_returns_json: counts stale or missing"
  else
    fail "test_ui_api_apply_returns_json: server did not start"
  fi
}

test_global_apply_returns_409_while_another_write_runs() {
  echo "Running test_global_apply_returns_409_while_another_write_runs..."
  local port=18822
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local stub="$tmp_dir/skills-add-stub"
  local lock_file="$tmp_dir/skills.lock.json"
  local active_dir="$tmp_dir/active"

  cat > "$lock_file" <<'JSON'
{"version":1,"custom":{"repo":"owner/catalog","skills":{"alpha":{"repoPath":"skills/a/alpha","category":"a"}}},"external":{},"vendor":{}}
JSON
  cat > "$tmp_dir/.skills-ignore.json" <<'JSON'
{"ignore":[]}
JSON
  cat > "$tmp_dir/.skill-lock.json" <<'JSON'
{"skills":{"alpha":{"sourceUrl":"https://github.com/owner-one/repo-one.git","skillPath":"skills/alpha/SKILL.md"}}}
JSON

  # install を掴んだまま離さないスタブ。これで「書き込み実行中」を決定論的に作る。
  cat > "$stub" <<'SH'
#!/bin/bash
sleep 4
exit 0
SH
  chmod +x "$stub"

  MY_SKILLS_ADD_SCRIPT="$stub" MY_SKILLS_ADD_ARGS_FILE="$tmp_dir/args.txt" \
    MY_SKILLS_LOCK_FILE="$lock_file" MY_SKILLS_IGNORE_FILE="$tmp_dir/.skills-ignore.json" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_ACTIVE_DIR="$active_dir" MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    # install は外部コマンドを待つ間ロックを握り続ける。同期で待つと Bun ごと
    # 止まって 409 すら返せなくなるので、その退行もここで捕まる。
    curl -s -o /dev/null -X POST "http://localhost:${port}/api/external/install" \
      -H "Content-Type: application/json" \
      -d '{"source":"owner-one/repo-one","skills":["alpha"]}' 2>/dev/null &
    local install_pid=$!
    sleep 1

    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/apply" \
      -H "Content-Type: application/json" \
      -d '{"states":{"alpha":"active"}}' 2>/dev/null || echo "000")

    [ "$http_code" = "409" ] \
      && pass "test_global_apply_returns_409_while_another_write_runs: HTTP 409" \
      || fail "test_global_apply_returns_409_while_another_write_runs: got HTTP $http_code"

    assert_contains "$(cat "$tmp_dir/response.json")" "Apply already running" \
      && pass "test_global_apply_returns_409_while_another_write_runs: explains why" \
      || fail "test_global_apply_returns_409_while_another_write_runs: no message"

    [ ! -e "$active_dir/alpha" ] \
      && pass "test_global_apply_returns_409_while_another_write_runs: wrote nothing" \
      || fail "test_global_apply_returns_409_while_another_write_runs: applied anyway"

    wait "$install_pid" 2>/dev/null || true
  else
    fail "test_global_apply_returns_409_while_another_write_runs: server did not start"
  fi
}

register_cases \
test_global_apply_posts_tristate_changes \
test_global_apply_restore_archived_skill \
test_global_apply_remove_active_skill \
test_global_apply_single_off_leaves_other_active_skills \
test_global_apply_empty_submission_returns_400 \
test_global_apply_off_deregisters_from_cli_lock \
test_global_apply_off_unlinks_agent_skill_dirs \
test_global_apply_archive_deregisters_and_unlinks \
test_global_apply_off_keeps_real_agent_directory \
test_global_apply_survives_broken_cli_lock \
test_global_apply_without_cli_lock_file \
test_global_apply_restore_repairs_broken_symlink \
test_global_apply_returns_409_while_another_write_runs \
test_ui_api_apply_returns_json
