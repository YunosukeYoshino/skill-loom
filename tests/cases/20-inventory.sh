# Inventory の表示と tristate の描画

test_ui_hides_repo_local_management_skills() {
  echo "Running test_ui_hides_repo_local_management_skills..."
  local port=18800
  ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local json
    json=$(curl -s "http://localhost:${port}/api/global" 2>/dev/null || true)

    ! assert_contains "$json" '"name": "skills-add"' \
      && ! assert_contains "$json" '"name":"skills-add"' \
      && pass "test_ui_hides_repo_local_management_skills: hides skills-add" \
      || fail "test_ui_hides_repo_local_management_skills: skills-add visible"

    ! assert_contains "$json" '"name": "skills-restore"' \
      && ! assert_contains "$json" '"name":"skills-restore"' \
      && pass "test_ui_hides_repo_local_management_skills: hides skills-restore" \
      || fail "test_ui_hides_repo_local_management_skills: skills-restore visible"
  else
    fail "test_ui_hides_repo_local_management_skills: server did not start"
  fi
}

test_ui_hides_ignored_skills() {
  echo "Running test_ui_hides_ignored_skills..."
  local port=18801
  ./skill-loom ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2

  if wait_for_port "$port"; then
    local json
    json=$(curl -s "http://localhost:${port}/api/global" 2>/dev/null || true)

    ! assert_contains "$json" '"name": "superpowers"' \
      && ! assert_contains "$json" '"name":"superpowers"' \
      && pass "test_ui_hides_ignored_skills: hides missing ignored skill" \
      || fail "test_ui_hides_ignored_skills: superpowers visible"

    ! assert_contains "$json" '"name": "simplify"' \
      && ! assert_contains "$json" '"name":"simplify"' \
      && pass "test_ui_hides_ignored_skills: hides archived ignored skill" \
      || fail "test_ui_hides_ignored_skills: simplify visible"
  else
    fail "test_ui_hides_ignored_skills: server did not start"
  fi
}

register_cases \
test_ui_hides_repo_local_management_skills \
test_ui_hides_ignored_skills