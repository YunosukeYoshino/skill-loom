# --json モードの E2E

test_json_status_is_a_single_object() {
  echo "Running test_json_status_is_a_single_object..."
  local out parsed
  out=$(MY_SKILLS_CATALOG_DIR="$REPO_ROOT/examples/catalog" ./skill-loom status --json 2>/dev/null)

  # stdout 全体を 1 つの JSON として parse できれば「1 オブジェクト 1 行」は満たされる。
  parsed=$(printf '%s' "$out" | bun -e '
    const o = JSON.parse(await Bun.stdin.text());
    for (const key of ["tracked", "ignored", "active", "archive"])
      if (typeof o[key] !== "number") process.exit(1);
    if (!Array.isArray(o.untracked)) process.exit(1);
    process.stdout.write("ok");
  ' 2>/dev/null)

  [ "$parsed" = "ok" ] \
    && pass "test_json_status_is_a_single_object: counts are numeric and untracked is a list" \
    || fail "test_json_status_is_a_single_object: output was $out"
}

test_json_list_is_jsonl() {
  echo "Running test_json_list_is_jsonl..."
  local out parsed
  out=$(MY_SKILLS_CATALOG_DIR="$REPO_ROOT/examples/catalog" ./skill-loom list --json 2>/dev/null)

  parsed=$(printf '%s\n' "$out" | bun -e '
    const lines = (await Bun.stdin.text()).trim().split("\n").filter(Boolean);
    if (lines.length === 0) process.exit(1);
    for (const line of lines) {
      const o = JSON.parse(line);
      if (typeof o.name !== "string" || typeof o.skills !== "number")
        process.exit(1);
    }
    process.stdout.write(String(lines.length));
  ' 2>/dev/null)

  [ -n "$parsed" ] \
    && pass "test_json_list_is_jsonl: every line parses as a deck object" \
    || fail "test_json_list_is_jsonl: output was $out"
}

test_json_mutation_needs_confirmation_off_tty() {
  echo "Running test_json_mutation_needs_confirmation_off_tty..."
  local tmp_dir before after out err rc
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"

  local loom_env=(
    MY_SKILLS_LOCK_FILE="$tmp_dir/skills.lock.json"
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active"
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive"
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json"
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills"
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills"
    MY_SKILLS_IGNORE_FILE="$tmp_dir/skills-ignore.json"
  )

  before=$(env "${loom_env[@]}" ./skill-loom status --json 2>/dev/null)

  # TTY でない stdin に -y 無しは、書き込み前に exit 2 で止まるのが契約。
  # set -e の下では代入がそのまま失敗するので、rc は if で受ける。
  if out=$(env "${loom_env[@]}" ./skill-loom skill archive alpha --json < /dev/null 2>"$tmp_dir/err.txt"); then
    rc=0
  else
    rc=$?
  fi
  err=$(tail -1 "$tmp_dir/err.txt")
  after=$(env "${loom_env[@]}" ./skill-loom status --json 2>/dev/null)

  [ "$rc" -eq 2 ] \
    && pass "test_json_mutation_needs_confirmation_off_tty: exits 2" \
    || fail "test_json_mutation_needs_confirmation_off_tty: exit was $rc"

  assert_contains "$out" '"applied":false' \
    && pass "test_json_mutation_needs_confirmation_off_tty: pending plan on stdout" \
    || fail "test_json_mutation_needs_confirmation_off_tty: stdout was $out"

  printf '%s' "$err" | bun -e '
    const o = JSON.parse(await Bun.stdin.text());
    if (o.error !== "confirmation required") process.exit(1);
  ' 2>/dev/null \
    && pass "test_json_mutation_needs_confirmation_off_tty: parseable error JSON on stderr" \
    || fail "test_json_mutation_needs_confirmation_off_tty: stderr was $err"

  [ "$before" = "$after" ] \
    && pass "test_json_mutation_needs_confirmation_off_tty: no writes before confirm" \
    || fail "test_json_mutation_needs_confirmation_off_tty: before=$before after=$after"
}

test_json_off_text_status_unchanged() {
  echo "Running test_json_off_text_status_unchanged..."
  local out
  out=$(MY_SKILLS_CATALOG_DIR="$REPO_ROOT/examples/catalog" ./skill-loom status 2>&1)

  for field in tracked ignored active archive; do
    assert_matches "$out" "^${field}:" \
      && pass "test_json_off_text_status_unchanged: has $field count" \
      || fail "test_json_off_text_status_unchanged: missing $field count"
  done
}

register_cases \
  test_json_status_is_a_single_object \
  test_json_list_is_jsonl \
  test_json_mutation_needs_confirmation_off_tty \
  test_json_off_text_status_unchanged
