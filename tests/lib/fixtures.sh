# テスト間で共有する Projection のフィクスチャとヘルパー。

# alpha/beta active, both listed in the inventory lock and the CLI lock, both
# symlinked from the agent-facing directories.
setup_projection_fixture() {
  local tmp_dir="$1"
  mkdir -p "$tmp_dir/active" "$tmp_dir/archive" "$tmp_dir/claude-skills" "$tmp_dir/gemini-skills"
  for skill in alpha beta; do
    mkdir "$tmp_dir/active/$skill"
    printf -- '---\nname: %s\ndescription: %s fixture\n---\n' "$skill" "$skill" \
      > "$tmp_dir/active/$skill/SKILL.md"
  done

  cat > "$tmp_dir/skills.lock.json" <<'JSON'
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

  cat > "$tmp_dir/.skill-lock.json" <<'JSON'
{
  "version": 3,
  "dismissed": ["update-notice"],
  "skills": {
    "alpha": {"source": "owner/repo-a", "installedAt": "2026-03-01T00:00:00.000Z"},
    "beta": {"source": "owner/repo-b", "installedAt": "2026-04-01T00:00:00.000Z"}
  }
}
JSON

  for skill in alpha beta; do
    ln -s "$tmp_dir/active/$skill" "$tmp_dir/claude-skills/$skill"
    ln -s "$tmp_dir/active/$skill" "$tmp_dir/gemini-skills/$skill"
  done
}

start_projection_ui() {
  local tmp_dir="$1" port="$2"
  MY_SKILLS_LOCK_FILE="$tmp_dir/skills.lock.json" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_GLOBAL_LOCK_FILE="$tmp_dir/.skill-lock.json" \
    MY_SKILLS_CLAUDE_SKILLS_DIR="$tmp_dir/claude-skills" \
    MY_SKILLS_GEMINI_SKILLS_DIR="$tmp_dir/gemini-skills" \
    ./my-skills ui --port "$port" > /dev/null 2>&1 &
  UI_PIDS+=($!)
  sleep 2
}

post_apply() {
  local tmp_dir="$1" port="$2" body="$3"
  curl -s -o "$tmp_dir/response.json" -w "%{http_code}" \
    -X POST "http://localhost:${port}/api/apply" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null || echo "000"
}
