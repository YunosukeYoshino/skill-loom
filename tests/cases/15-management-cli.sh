# Management command families exposed through the public ./skill-loom seam.

setup_management_cli_fixture() {
  local tmp_dir="$1"
  mkdir -p "$tmp_dir/active" "$tmp_dir/archive" "$tmp_dir/project-decks" \
    "$tmp_dir/shared-decks" "$tmp_dir/drafts/skills" "$tmp_dir/claude-skills" \
    "$tmp_dir/gemini-skills" "$tmp_dir/presets"

  cat > "$tmp_dir/skills.lock.json" <<'JSON'
{
  "version": 1,
  "custom": {"repo": "owner/catalog", "skills": {}},
  "external": {
    "alpha": {"source": "owner/tools", "sourceUrl": "https://github.com/owner/tools.git", "skillPath": "skills/alpha/SKILL.md"},
    "beta": {"source": "owner/tools", "sourceUrl": "https://github.com/owner/tools.git", "skillPath": "skills/beta/SKILL.md"}
  },
  "vendor": {}
}
JSON
  printf '{"ignore":[]}\n' > "$tmp_dir/.skills-ignore.json"
  printf '{"version":3,"skills":{}}\n' > "$tmp_dir/.skill-lock.json"
  printf '{"name":"core","skills":[]}\n' > "$tmp_dir/shared-decks/core.json"
}

run_management_cli() {
  local tmp_dir="$1"
  shift
  MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" \
    MY_SKILLS_PRESETS_DIR="$tmp_dir/presets" \
    MY_SKILLS_AUTO_COMMIT=0 \
    ./skill-loom --catalog-dir "$tmp_dir" "$@" \
    > "$tmp_dir/cli-stdout.txt" 2> "$tmp_dir/cli-stderr.txt" \
    && echo 0 || echo $?
}

test_management_cli_external_list_groups_catalog_sources() {
  echo "Running test_management_cli_external_list_groups_catalog_sources..."
  local tmp_dir rc out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_management_cli_fixture "$tmp_dir"

  rc=$(run_management_cli "$tmp_dir" external list)
  out=$(< "$tmp_dir/cli-stdout.txt")

  [ "$rc" = "0" ] \
    && pass "test_management_cli_external_list_groups_catalog_sources: exits 0" \
    || fail "test_management_cli_external_list_groups_catalog_sources: exit code $rc"

  assert_contains "$out" "External sources:" \
    && assert_contains "$out" "owner/tools" \
    && assert_contains "$out" "alpha, beta" \
    && pass "test_management_cli_external_list_groups_catalog_sources: groups skills by source" \
    || fail "test_management_cli_external_list_groups_catalog_sources: output was $out"
}

test_management_cli_external_check_reports_updates_without_mutating() {
  echo "Running test_management_cli_external_check_reports_updates_without_mutating..."
  local tmp_dir rc out before
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_management_cli_fixture "$tmp_dir"
  mkdir -p "$tmp_dir/active/alpha"
  printf -- '---\nname: alpha\ndescription: installed\n---\n' > "$tmp_dir/active/alpha/SKILL.md"
  cat > "$tmp_dir/candidates.json" <<'JSON'
[
  {"name":"alpha","path":"skills/alpha/SKILL.md","contentHash":"remote-hash"},
  {"name":"beta","path":"skills/beta/SKILL.md","contentHash":"remote-hash"}
]
JSON
  before=$(< "$tmp_dir/skills.lock.json")

  rc=$(MY_SKILLS_EXTERNAL_CANDIDATES_FILE="$tmp_dir/candidates.json" \
    run_management_cli "$tmp_dir" external check)
  out=$(< "$tmp_dir/cli-stdout.txt")

  [ "$rc" = "0" ] \
    && assert_contains "$out" "owner/tools" \
    && assert_contains "$out" "updates: alpha" \
    && pass "test_management_cli_external_check_reports_updates_without_mutating: reports active update" \
    || fail "test_management_cli_external_check_reports_updates_without_mutating: rc=$rc output=$out"

  [ "$(< "$tmp_dir/skills.lock.json")" = "$before" ] \
    && pass "test_management_cli_external_check_reports_updates_without_mutating: Catalog unchanged" \
    || fail "test_management_cli_external_check_reports_updates_without_mutating: Catalog changed"
}

test_management_cli_external_preview_lists_source_candidates() {
  echo "Running test_management_cli_external_preview_lists_source_candidates..."
  local tmp_dir rc out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_management_cli_fixture "$tmp_dir"
  cat > "$tmp_dir/candidates.json" <<'JSON'
[
  {"name":"alpha","description":"Installed candidate","path":"skills/alpha/SKILL.md"},
  {"name":"gamma","description":"Available candidate","path":"tools/gamma/SKILL.md"}
]
JSON

  rc=$(MY_SKILLS_EXTERNAL_CANDIDATES_FILE="$tmp_dir/candidates.json" \
    run_management_cli "$tmp_dir" external preview owner/tools)
  out=$(< "$tmp_dir/cli-stdout.txt")

  [ "$rc" = "0" ] \
    && assert_contains "$out" "External source: owner/tools" \
    && assert_contains "$out" "alpha" \
    && assert_contains "$out" "gamma" \
    && assert_contains "$out" "tools/gamma/SKILL.md" \
    && pass "test_management_cli_external_preview_lists_source_candidates: lists candidates" \
    || fail "test_management_cli_external_preview_lists_source_candidates: rc=$rc output=$out"
}

test_management_cli_external_update_aborts_without_confirmation() {
  echo "Running test_management_cli_external_update_aborts_without_confirmation..."
  local tmp_dir rc out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_management_cli_fixture "$tmp_dir"
  mkdir -p "$tmp_dir/active/alpha"
  printf -- '---\nname: alpha\ndescription: installed\n---\n' > "$tmp_dir/active/alpha/SKILL.md"
  cat > "$tmp_dir/update-stub" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$MY_SKILLS_COMMAND_ARGS_FILE"
SH
  chmod +x "$tmp_dir/update-stub"

  rc=$(MY_SKILLS_UPDATE_BIN="$tmp_dir/update-stub" \
    MY_SKILLS_COMMAND_ARGS_FILE="$tmp_dir/update-args.txt" \
    run_management_cli "$tmp_dir" external update alpha)
  out=$(< "$tmp_dir/cli-stdout.txt")

  [ "$rc" = "1" ] \
    && assert_contains "$out" "Update External Skills: alpha" \
    && assert_contains "$out" "Aborted." \
    && pass "test_management_cli_external_update_aborts_without_confirmation: previews and aborts" \
    || fail "test_management_cli_external_update_aborts_without_confirmation: rc=$rc output=$out"

  [ ! -e "$tmp_dir/update-args.txt" ] \
    && pass "test_management_cli_external_update_aborts_without_confirmation: command not run" \
    || fail "test_management_cli_external_update_aborts_without_confirmation: update command ran"
}

test_management_cli_external_update_yes_runs_selected_skill() {
  echo "Running test_management_cli_external_update_yes_runs_selected_skill..."
  local tmp_dir rc out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_management_cli_fixture "$tmp_dir"
  mkdir -p "$tmp_dir/active/alpha"
  printf -- '---\nname: alpha\ndescription: installed\n---\n' > "$tmp_dir/active/alpha/SKILL.md"
  cat > "$tmp_dir/update-stub" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$MY_SKILLS_COMMAND_ARGS_FILE"
SH
  chmod +x "$tmp_dir/update-stub"

  rc=$(MY_SKILLS_UPDATE_BIN="$tmp_dir/update-stub" \
    MY_SKILLS_COMMAND_ARGS_FILE="$tmp_dir/update-args.txt" \
    run_management_cli "$tmp_dir" external update alpha --yes)
  out=$(< "$tmp_dir/cli-stdout.txt")

  [ "$rc" = "0" ] \
    && assert_contains "$out" "Updated: alpha" \
    && assert_contains "$(< "$tmp_dir/update-args.txt")" $'skills\nupdate\nalpha\n-g\n-y' \
    && pass "test_management_cli_external_update_yes_runs_selected_skill: exact argv" \
    || fail "test_management_cli_external_update_yes_runs_selected_skill: rc=$rc output=$out"
}

test_management_cli_custom_check_and_update_use_catalog_source() {
  echo "Running test_management_cli_custom_check_and_update_use_catalog_source..."
  local tmp_dir rc out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_management_cli_fixture "$tmp_dir"
  mkdir -p "$tmp_dir/skills/tools/alpha" "$tmp_dir/active/alpha"
  printf -- '---\nname: alpha\ndescription: authored\n---\n' > "$tmp_dir/skills/tools/alpha/SKILL.md"
  printf -- '---\nname: alpha\ndescription: installed\n---\n' > "$tmp_dir/active/alpha/SKILL.md"
  bun -e 'const fs=require("fs"); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p)); j.custom.skills.alpha={repoPath:"skills/tools/alpha",category:"tools"}; fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' "$tmp_dir/skills.lock.json"

  rc=$(run_management_cli "$tmp_dir" custom check)
  out=$(< "$tmp_dir/cli-stdout.txt")
  [ "$rc" = "0" ] && assert_contains "$out" "alpha" \
    && pass "test_management_cli_custom_check_and_update_use_catalog_source: drift listed" \
    || fail "test_management_cli_custom_check_and_update_use_catalog_source: check rc=$rc output=$out"

  rc=$(run_management_cli "$tmp_dir" custom update alpha --yes)
  out=$(< "$tmp_dir/cli-stdout.txt")
  [ "$rc" = "0" ] && assert_contains "$out" "Updated: alpha" \
    && assert_contains "$(< "$tmp_dir/active/alpha/SKILL.md")" "authored" \
    && pass "test_management_cli_custom_check_and_update_use_catalog_source: updated copy" \
    || fail "test_management_cli_custom_check_and_update_use_catalog_source: update rc=$rc output=$out"
}

test_management_cli_draft_list_and_promote_are_confirmed() {
  echo "Running test_management_cli_draft_list_and_promote_are_confirmed..."
  local tmp_dir rc out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_management_cli_fixture "$tmp_dir"
  mkdir -p "$tmp_dir/drafts/skills/tools/gamma"
  printf -- '---\nname: gamma\ndescription: Draft gamma\n---\n' > "$tmp_dir/drafts/skills/tools/gamma/SKILL.md"

  rc=$(run_management_cli "$tmp_dir" draft list)
  out=$(< "$tmp_dir/cli-stdout.txt")
  [ "$rc" = "0" ] && assert_contains "$out" "gamma" && assert_contains "$out" "Draft gamma" \
    && pass "test_management_cli_draft_list_and_promote_are_confirmed: listed" \
    || fail "test_management_cli_draft_list_and_promote_are_confirmed: list rc=$rc output=$out"

  rc=$(run_management_cli "$tmp_dir" draft promote gamma --yes)
  out=$(< "$tmp_dir/cli-stdout.txt")
  [ "$rc" = "0" ] && assert_contains "$out" "Promoted: gamma" \
    && [ -f "$tmp_dir/skills/tools/gamma/SKILL.md" ] \
    && [ ! -e "$tmp_dir/drafts/skills/tools/gamma" ] \
    && assert_contains "$(< "$tmp_dir/skills.lock.json")" '"gamma"' \
    && pass "test_management_cli_draft_list_and_promote_are_confirmed: promoted" \
    || fail "test_management_cli_draft_list_and_promote_are_confirmed: promote rc=$rc output=$out"
}

test_management_cli_deck_show_and_save_are_confirmed() {
  echo "Running test_management_cli_deck_show_and_save_are_confirmed..."
  local tmp_dir rc out
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_management_cli_fixture "$tmp_dir"
  printf '{"name":"work","description":"Work deck","skills":["alpha"]}\n' > "$tmp_dir/project-decks/work.json"

  rc=$(run_management_cli "$tmp_dir" deck show work)
  out=$(< "$tmp_dir/cli-stdout.txt")
  [ "$rc" = "0" ] && assert_contains "$out" "Work deck" && assert_contains "$out" "alpha" \
    && pass "test_management_cli_deck_show_and_save_are_confirmed: shown" \
    || fail "test_management_cli_deck_show_and_save_are_confirmed: show rc=$rc output=$out"

  rc=$(run_management_cli "$tmp_dir" deck save work beta --yes)
  out=$(< "$tmp_dir/cli-stdout.txt")
  [ "$rc" = "0" ] && assert_contains "$out" "Saved deck: work" \
    && assert_contains "$(< "$tmp_dir/project-decks/work.json")" '"beta"' \
    && pass "test_management_cli_deck_show_and_save_are_confirmed: saved" \
    || fail "test_management_cli_deck_show_and_save_are_confirmed: save rc=$rc output=$out"

  mkdir -p "$tmp_dir/active/alpha"
  rc=$(run_management_cli "$tmp_dir" deck apply work)
  out=$(< "$tmp_dir/cli-stdout.txt")
  [ "$rc" = "1" ] && assert_contains "$out" "Apply Project Deck work" \
    && assert_contains "$out" "Aborted." && [ -d "$tmp_dir/active/alpha" ] \
    && pass "test_management_cli_deck_show_and_save_are_confirmed: apply aborts safely" \
    || fail "test_management_cli_deck_show_and_save_are_confirmed: apply rc=$rc output=$out"
}

register_cases \
  test_management_cli_external_list_groups_catalog_sources \
  test_management_cli_external_check_reports_updates_without_mutating \
  test_management_cli_external_preview_lists_source_candidates \
  test_management_cli_external_update_aborts_without_confirmation \
  test_management_cli_external_update_yes_runs_selected_skill \
  test_management_cli_custom_check_and_update_use_catalog_source \
  test_management_cli_draft_list_and_promote_are_confirmed \
  test_management_cli_deck_show_and_save_are_confirmed
