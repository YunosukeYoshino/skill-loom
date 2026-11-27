# プロジェクトの個別操作は専用サンドボックスだけを書き換える。
test_project_cli() {
  echo "Running test_project_cli..."
  local root out
  root=$(mktemp -d)
  TMP_DIRS+=("$root")
  mkdir -p "$root/repo"
  out=$(MY_SKILLS_PROJECTS_DIR="$root/registry" ./skill-loom project add work "$root/repo" -y --json 2>&1)
  assert_contains "$out" '"name":"work"' && pass "project: register path only" || fail "project: register" "$out"
  out=$(MY_SKILLS_PROJECTS_DIR="$root/registry" ./skill-loom --catalog-dir "$REPO_ROOT/examples/catalog" project status work --json 2>&1)
  assert_contains "$out" '"skills":[]' && pass "project: empty status" || fail "project: status" "$out"
  out=$(MY_SKILLS_PROJECTS_DIR="$root/registry" ./skill-loom project list --json 2>&1)
  assert_contains "$out" '"name":"work"' && pass "project: list" || fail "project: list" "$out"
  mkdir -p "$root/catalog/drafts/skills" "$root/repo/.agents/skills/local-skill"
  cp -R "$REPO_ROOT/examples/catalog/." "$root/catalog/"
  printf '%s\n' '---' 'name: local-skill' 'description: Local project skill' '---' 'Local content' > "$root/repo/.agents/skills/local-skill/SKILL.md"
  out=$(MY_SKILLS_PROJECTS_DIR="$root/registry" MY_SKILLS_AUTO_COMMIT=0 ./skill-loom --catalog-dir "$root/catalog" project import work local-skill team -y --json 2>&1)
  if [ -f "$root/catalog/drafts/skills/team/local-skill/SKILL.md" ] && [ -f "$root/repo/.agents/skills/local-skill/SKILL.md" ] && assert_contains "$out" '"importedDraft"'; then pass "project: import creates Draft and preserves project"; else fail "project: import" "$out"; fi
  out=$(MY_SKILLS_PROJECTS_DIR="$root/registry" MY_SKILLS_AUTO_COMMIT=0 ./skill-loom --catalog-dir "$root/catalog" project import work local-skill -y --json 2>&1) || true
  assert_contains "$out" 'already exists' && pass "project: duplicate import rejected" || fail "project: duplicate import" "$out"
  out=$(MY_SKILLS_PROJECTS_DIR="$root/registry" ./skill-loom project remove work -y --json 2>&1)
  if [ -d "$root/repo" ] && assert_contains "$out" '"removed":"work"'; then pass "project: unregister leaves repo"; else fail "project: unregister" "$out"; fi
}
register_cases test_project_cli
