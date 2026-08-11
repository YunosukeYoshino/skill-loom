# 外部 skill のソース管理・更新・インストール

start_external_source_fixture_ui() {
  local tmp_dir="$1" port="$2" fixture="$3"
  mkdir -p "$tmp_dir/active/alpha" "$tmp_dir/archive"
  printf -- '---\nname: alpha\ndescription: installed fixture\n---\n' > "$tmp_dir/active/alpha/SKILL.md"
  cat > "$tmp_dir/skills.lock.json" <<'JSON'
{
  "version": 1,
  "custom": {"repo": "owner/catalog", "skills": {}},
  "external": {
    "alpha": {
      "source": "owner-one/repo-one",
      "sourceUrl": "https://github.com/owner-one/repo-one.git",
      "skillPath": "skills/alpha/SKILL.md"
    }
  },
  "vendor": {}
}
JSON
  MY_SKILLS_CATALOG_DIR="$tmp_dir" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_EXTERNAL_CANDIDATES_FILE="$fixture" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2
}

test_external_update_posts_to_skills_update_command() {
  echo "Running test_external_update_posts_to_skills_update_command..."
  local port=18803
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local stub="$tmp_dir/bunx-stub"
  local args_file="$tmp_dir/update-args.txt"
  local lock_file="$tmp_dir/skills.lock.json"
  local active_dir="$tmp_dir/active"
  local archive_dir="$tmp_dir/archive"
  mkdir -p "$active_dir/alpha" "$archive_dir"
  printf '%s\n' 'local alpha' > "$active_dir/alpha/SKILL.md"

  cat > "$lock_file" <<'JSON'
{
  "version": 1,
  "custom": {"repo": "owner/catalog", "skills": {}},
  "external": {
    "alpha": {
      "source": "owner-one/repo-one",
      "sourceUrl": "https://github.com/owner-one/repo-one.git",
      "skillPath": "skills/alpha/SKILL.md"
    }
  },
  "vendor": {}
}
JSON

  cat > "$stub" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$MY_SKILLS_UPDATE_ARGS_FILE"
exit 0
SH
  chmod +x "$stub"

  MY_SKILLS_LOCK_FILE="$lock_file" \
    MY_SKILLS_ACTIVE_DIR="$active_dir" MY_SKILLS_ARCHIVE_DIR="$archive_dir" \
    MY_SKILLS_UPDATE_BIN="$stub" MY_SKILLS_UPDATE_ARGS_FILE="$args_file" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/external-sources/update" \
      -H "Content-Type: application/json" \
      -d '{"skill":"alpha"}' 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_external_update_posts_to_skills_update_command: HTTP 200" \
      || fail "test_external_update_posts_to_skills_update_command: got HTTP $http_code"

    assert_contains "$(cat "$args_file" 2>/dev/null || true)" "update" \
      && pass "test_external_update_posts_to_skills_update_command: passes update command" \
      || fail "test_external_update_posts_to_skills_update_command: update command missing"

    assert_contains "$(cat "$args_file" 2>/dev/null || true)" "alpha" \
      && pass "test_external_update_posts_to_skills_update_command: passes selected skill" \
      || fail "test_external_update_posts_to_skills_update_command: selected skill missing"
  else
    fail "test_external_update_posts_to_skills_update_command: server did not start"
  fi
}

test_external_remove_posts_to_remove_command_and_updates_lock() {
  echo "Running test_external_remove_posts_to_remove_command_and_updates_lock..."
  local port=18806
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local stub="$tmp_dir/bunx-stub"
  local args_file="$tmp_dir/remove-args.txt"
  local lock_file="$tmp_dir/skills.lock.json"
  local decks_dir="$tmp_dir/project-decks"
  mkdir -p "$decks_dir"

  cat > "$stub" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$MY_SKILLS_REMOVE_ARGS_FILE"
exit 0
SH
  chmod +x "$stub"

  cat > "$lock_file" <<'JSON'
{
  "version": 1,
  "custom": {"repo": "owner/catalog", "skills": {}},
  "external": {
    "alpha": {
      "source": "owner-one/repo-one",
      "sourceUrl": "https://github.com/owner-one/repo-one.git",
      "skillPath": "skills/alpha/SKILL.md"
    },
    "beta": {
      "source": "owner-one/repo-one",
      "sourceUrl": "https://github.com/owner-one/repo-one.git",
      "skillPath": "skills/beta/SKILL.md"
    }
  },
  "vendor": {}
}
JSON
  cat > "$decks_dir/api.json" <<'JSON'
{"skills":["alpha","beta"]}
JSON

  MY_SKILLS_LOCK_FILE="$lock_file" MY_SKILLS_PROJECT_DECKS_DIR="$decks_dir" \
    MY_SKILLS_REMOVE_BIN="$stub" MY_SKILLS_REMOVE_ARGS_FILE="$args_file" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/external-sources/remove" \
      -H "Content-Type: application/json" \
      -d '{"skill":"alpha"}' 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_external_remove_posts_to_remove_command_and_updates_lock: HTTP 200" \
      || fail "test_external_remove_posts_to_remove_command_and_updates_lock: got HTTP $http_code"

    assert_contains "$(cat "$args_file" 2>/dev/null || true)" "remove" \
      && pass "test_external_remove_posts_to_remove_command_and_updates_lock: passes remove command" \
      || fail "test_external_remove_posts_to_remove_command_and_updates_lock: remove command missing"

    ! assert_contains "$(cat "$lock_file")" '"alpha"' \
      && pass "test_external_remove_posts_to_remove_command_and_updates_lock: removes lock entry" \
      || fail "test_external_remove_posts_to_remove_command_and_updates_lock: lock entry remains"

    ! assert_contains "$(cat "$decks_dir/api.json")" '"alpha"' \
      && pass "test_external_remove_posts_to_remove_command_and_updates_lock: removes deck entry" \
      || fail "test_external_remove_posts_to_remove_command_and_updates_lock: deck entry remains"
  else
    fail "test_external_remove_posts_to_remove_command_and_updates_lock: server did not start"
  fi
}

test_external_source_detail_route_uses_candidate_fixture() {
  echo "Running test_external_source_detail_route_uses_candidate_fixture..."
  local port=18804
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local fixture="$tmp_dir/candidates.json"
  cat > "$fixture" <<'JSON'
[
  {"name":"alpha","description":"Fixture installed skill","path":"skills/alpha/SKILL.md"},
  {"name":"beta","description":"Fixture available skill","path":"skills/beta/SKILL.md"}
]
JSON

  start_external_source_fixture_ui "$tmp_dir" "$port" "$fixture"

  if wait_for_port "$port"; then
    local html
    html=$(curl -s "http://localhost:${port}/api/external-sources/owner-one/repo-one" 2>/dev/null || true)

    assert_contains "$html" '"title":"owner-one/repo-one"' \
      && pass "test_external_source_detail_route_uses_candidate_fixture: has detail title" \
      || fail "test_external_source_detail_route_uses_candidate_fixture: detail title missing"

    assert_contains "$html" "beta" \
      && pass "test_external_source_detail_route_uses_candidate_fixture: shows fixture candidate" \
      || fail "test_external_source_detail_route_uses_candidate_fixture: fixture candidate missing"
  else
    fail "test_external_source_detail_route_uses_candidate_fixture: server did not start"
  fi
}

test_external_check_updates_post_opens_source_detail() {
  echo "Running test_external_check_updates_post_opens_source_detail..."
  local port=18805
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local fixture="$tmp_dir/candidates.json"
  cat > "$fixture" <<'JSON'
[
  {"name":"alpha","description":"Fixture installed skill","path":"skills/alpha/SKILL.md"},
  {"name":"beta","description":"Fixture available skill","path":"skills/beta/SKILL.md"}
]
JSON

  start_external_source_fixture_ui "$tmp_dir" "$port" "$fixture"

  if wait_for_port "$port"; then
    local html
    html=$(curl -s -X POST "http://localhost:${port}/api/external-sources/check-updates" \
      -H "Content-Type: application/json" \
      -d '{"source":"owner-one/repo-one"}' 2>/dev/null || true)

    assert_contains "$html" '"title":"owner-one/repo-one"' \
      && pass "test_external_check_updates_post_opens_source_detail: opens detail" \
      || fail "test_external_check_updates_post_opens_source_detail: detail missing"

    assert_contains "$html" "beta" \
      && pass "test_external_check_updates_post_opens_source_detail: shows available candidate" \
      || fail "test_external_check_updates_post_opens_source_detail: available candidate missing"
  else
    fail "test_external_check_updates_post_opens_source_detail: server did not start"
  fi
}

test_external_check_all_updates_shows_status_on_sources_page() {
  echo "Running test_external_check_all_updates_shows_status_on_sources_page..."
  local port=18814
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local fixture="$tmp_dir/candidates.json"
  cat > "$fixture" <<'JSON'
[
  {"name":"alpha","description":"Fixture installed skill","path":"skills/alpha/SKILL.md","contentHash":"deadbeef"},
  {"name":"beta","description":"Fixture available skill","path":"skills/beta/SKILL.md"}
]
JSON

  start_external_source_fixture_ui "$tmp_dir" "$port" "$fixture"

  if wait_for_port "$port"; then
    local html
    html=$(curl -s -X POST "http://localhost:${port}/api/external-sources/check-all-updates" \
      -H "Content-Type: application/json" -d '{}' 2>/dev/null || true)

    assert_contains "$html" "更新確認完了" \
      && pass "test_external_check_all_updates_shows_status_on_sources_page: shows summary message" \
      || fail "test_external_check_all_updates_shows_status_on_sources_page: summary message missing"

    assert_contains "$html" "totalUpdatable" \
      && pass "test_external_check_all_updates_shows_status_on_sources_page: shows update count" \
      || fail "test_external_check_all_updates_shows_status_on_sources_page: update count missing"
  else
    fail "test_external_check_all_updates_shows_status_on_sources_page: server did not start"
  fi
}

test_external_update_all_posts_multiple_skills() {
  echo "Running test_external_update_all_posts_multiple_skills..."
  local port=18813
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local stub="$tmp_dir/bunx-stub"
  local args_file="$tmp_dir/update-all-args.txt"
  local fixture="$tmp_dir/candidates.json"
  local lock_file="$tmp_dir/skills.lock.json"
  local active_dir="$tmp_dir/active"
  local archive_dir="$tmp_dir/archive"
  mkdir -p "$active_dir/alpha" "$active_dir/beta" "$archive_dir"
  printf '%s\n' 'local alpha' > "$active_dir/alpha/SKILL.md"
  printf '%s\n' 'local beta' > "$active_dir/beta/SKILL.md"

  cat > "$lock_file" <<'JSON'
{
  "version": 1,
  "custom": {"repo": "owner/catalog", "skills": {}},
  "external": {
    "alpha": {
      "source": "owner-one/repo-one",
      "sourceUrl": "https://github.com/owner-one/repo-one.git",
      "skillPath": "skills/alpha/SKILL.md"
    },
    "beta": {
      "source": "owner-one/repo-one",
      "sourceUrl": "https://github.com/owner-one/repo-one.git",
      "skillPath": "skills/beta/SKILL.md"
    }
  },
  "vendor": {}
}
JSON

  cat > "$stub" <<'SH'
#!/bin/bash
printf '%s\n' "$@" >> "$MY_SKILLS_UPDATE_ARGS_FILE"
exit 0
SH
  chmod +x "$stub"
  : > "$args_file"
  python3 - <<'PY' > "$fixture"
import hashlib
import json

candidates = [
    {
        "name": "alpha",
        "description": "Fixture installed skill",
        "path": "skills/alpha/SKILL.md",
        "contentHash": hashlib.sha256(b"remote alpha\n").hexdigest(),
    },
    {
        "name": "beta",
        "description": "Fixture installed skill",
        "path": "skills/beta/SKILL.md",
        "contentHash": hashlib.sha256(b"remote beta\n").hexdigest(),
    },
]
print(json.dumps(candidates))
PY

  MY_SKILLS_LOCK_FILE="$lock_file" \
    MY_SKILLS_ACTIVE_DIR="$active_dir" MY_SKILLS_ARCHIVE_DIR="$archive_dir" \
    MY_SKILLS_UPDATE_BIN="$stub" MY_SKILLS_UPDATE_ARGS_FILE="$args_file" \
    MY_SKILLS_EXTERNAL_CANDIDATES_FILE="$fixture" ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/external-sources/update-all" \
      -H "Content-Type: application/json" \
      -d '{}' 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_external_update_all_posts_multiple_skills: HTTP 200" \
      || fail "test_external_update_all_posts_multiple_skills: got HTTP $http_code"

    assert_contains "$(cat "$args_file" 2>/dev/null || true)" "alpha" \
      && pass "test_external_update_all_posts_multiple_skills: updates alpha" \
      || fail "test_external_update_all_posts_multiple_skills: alpha missing"

    assert_contains "$(cat "$args_file" 2>/dev/null || true)" "beta" \
      && pass "test_external_update_all_posts_multiple_skills: updates beta" \
      || fail "test_external_update_all_posts_multiple_skills: beta missing"
  else
    fail "test_external_update_all_posts_multiple_skills: server did not start"
  fi
}

test_external_install_posts_to_skills_add_script() {
  echo "Running test_external_install_posts_to_skills_add_script..."
  local port=18802
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local stub="$tmp_dir/skills-add-stub"
  local args_file="$tmp_dir/args.txt"
  local lock_file="$tmp_dir/skills.lock.json"
  local ignore_file="$tmp_dir/.skills-ignore.json"
  local global_lock_file="$tmp_dir/.skill-lock.json"

  cat > "$lock_file" <<'JSON'
{"version":1,"custom":{"repo":"owner/catalog","skills":{}},"external":{},"vendor":{}}
JSON
  cat > "$ignore_file" <<'JSON'
{"ignore":["spec-driven-development"]}
JSON
  cat > "$global_lock_file" <<'JSON'
{"skills":{"spec-driven-development":{"sourceUrl":"https://github.com/addyosmani/agent-skills.git","skillPath":"skills/spec-driven-development/SKILL.md"}}}
JSON

  cat > "$stub" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$MY_SKILLS_ADD_ARGS_FILE"
exit 0
SH
  chmod +x "$stub"

  MY_SKILLS_ADD_SCRIPT="$stub" MY_SKILLS_ADD_ARGS_FILE="$args_file" \
    MY_SKILLS_LOCK_FILE="$lock_file" MY_SKILLS_IGNORE_FILE="$ignore_file" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$global_lock_file" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/external/install" \
      -H "Content-Type: application/json" \
      -d '{"source":"addyosmani/agent-skills","skills":["spec-driven-development"]}' 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_external_install_posts_to_skills_add_script: HTTP 200" \
      || fail "test_external_install_posts_to_skills_add_script: got HTTP $http_code"

    assert_contains "$(cat "$args_file" 2>/dev/null || true)" "addyosmani/agent-skills" \
      && pass "test_external_install_posts_to_skills_add_script: passes source" \
      || fail "test_external_install_posts_to_skills_add_script: source not passed"

    assert_contains "$(cat "$args_file" 2>/dev/null || true)" "spec-driven-development" \
      && pass "test_external_install_posts_to_skills_add_script: passes selected skill" \
      || fail "test_external_install_posts_to_skills_add_script: skill not passed"

    assert_contains "$(cat "$lock_file" 2>/dev/null || true)" '"spec-driven-development"' \
      && pass "test_external_install_posts_to_skills_add_script: registers selected skill" \
      || fail "test_external_install_posts_to_skills_add_script: selected skill not registered"

    ! assert_contains "$(cat "$ignore_file" 2>/dev/null || true)" '"spec-driven-development"' \
      && pass "test_external_install_posts_to_skills_add_script: unignores selected skill" \
      || fail "test_external_install_posts_to_skills_add_script: selected skill still ignored"
  else
    fail "test_external_install_posts_to_skills_add_script: server did not start"
  fi
}

test_external_install_posts_bulk_selection_to_one_skills_add_command() {
  echo "Running test_external_install_posts_bulk_selection_to_one_skills_add_command..."
  local port=18807
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  local stub="$tmp_dir/skills-add-stub"
  local args_file="$tmp_dir/args.txt"
  local lock_file="$tmp_dir/skills.lock.json"
  local ignore_file="$tmp_dir/.skills-ignore.json"
  local global_lock_file="$tmp_dir/.skill-lock.json"

  cat > "$lock_file" <<'JSON'
{"version":1,"custom":{"repo":"owner/catalog","skills":{}},"external":{},"vendor":{}}
JSON
  cat > "$ignore_file" <<'JSON'
{"ignore":[]}
JSON
  cat > "$global_lock_file" <<'JSON'
{"skills":{"alpha":{"sourceUrl":"https://github.com/owner-one/repo-one.git","skillPath":"skills/alpha/SKILL.md"},"beta":{"sourceUrl":"https://github.com/owner-one/repo-one.git","skillPath":"skills/beta/SKILL.md"}}}
JSON

  cat > "$stub" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$MY_SKILLS_ADD_ARGS_FILE"
exit 0
SH
  chmod +x "$stub"

  MY_SKILLS_ADD_SCRIPT="$stub" MY_SKILLS_ADD_ARGS_FILE="$args_file" \
    MY_SKILLS_LOCK_FILE="$lock_file" MY_SKILLS_IGNORE_FILE="$ignore_file" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$global_lock_file" \
    ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local http_code
    http_code=$(curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
      -X POST "http://localhost:${port}/api/external/install" \
      -H "Content-Type: application/json" \
      -d '{"source":"owner-one/repo-one","skills":["alpha","beta"]}' 2>/dev/null || echo "000")

    [ "$http_code" = "200" ] \
      && pass "test_external_install_posts_bulk_selection_to_one_skills_add_command: HTTP 200" \
      || fail "test_external_install_posts_bulk_selection_to_one_skills_add_command: got HTTP $http_code"

    [ "$(grep -c -- '--skill' "$args_file" 2>/dev/null || true)" = "2" ] \
      && pass "test_external_install_posts_bulk_selection_to_one_skills_add_command: passes two skill filters" \
      || fail "test_external_install_posts_bulk_selection_to_one_skills_add_command: did not pass two skill filters"

    assert_contains "$(cat "$args_file" 2>/dev/null || true)" "alpha" \
      && pass "test_external_install_posts_bulk_selection_to_one_skills_add_command: passes alpha" \
      || fail "test_external_install_posts_bulk_selection_to_one_skills_add_command: alpha missing"

    assert_contains "$(cat "$args_file" 2>/dev/null || true)" "beta" \
      && pass "test_external_install_posts_bulk_selection_to_one_skills_add_command: passes beta" \
      || fail "test_external_install_posts_bulk_selection_to_one_skills_add_command: beta missing"

    assert_contains "$(cat "$lock_file" 2>/dev/null || true)" '"alpha"' \
      && assert_contains "$(cat "$lock_file" 2>/dev/null || true)" '"beta"' \
      && pass "test_external_install_posts_bulk_selection_to_one_skills_add_command: registers both skills" \
      || fail "test_external_install_posts_bulk_selection_to_one_skills_add_command: both skills not registered"
  else
    fail "test_external_install_posts_bulk_selection_to_one_skills_add_command: server did not start"
  fi
}

register_cases \
test_external_update_posts_to_skills_update_command \
test_external_remove_posts_to_remove_command_and_updates_lock \
test_external_source_detail_route_uses_candidate_fixture \
test_external_check_updates_post_opens_source_detail \
test_external_check_all_updates_shows_status_on_sources_page \
test_external_update_all_posts_multiple_skills \
test_external_install_posts_to_skills_add_script \
test_external_install_posts_bulk_selection_to_one_skills_add_command
