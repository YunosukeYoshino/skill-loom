# 開発時トポロジ: Hono 公開ポート vs Vite 内部ポート。
# harness は MY_SKILLS_VITE=0（dist 配信）が既定なので、ここだけ Vite を起こして
# 「内部ポート直叩きで /api が HTML 200 に落ちない」契約を固定する。

test_vite_direct_api_returns_json_502_not_spa_html() {
  echo "Running test_vite_direct_api_returns_json_502_not_spa_html..."
  local port=18980
  local tmp_dir
  tmp_dir=$(mktemp -d)
  TMP_DIRS+=("$tmp_dir")
  setup_projection_fixture "$tmp_dir"

  # harness の MY_SKILLS_VITE=0 を上書きして Vite 子プロセスを起動する。
  MY_SKILLS_VITE=1 MY_SKILLS_CATALOG_DIR="$tmp_dir" \
    MY_SKILLS_ACTIVE_DIR="$tmp_dir/active" \
    MY_SKILLS_ARCHIVE_DIR="$tmp_dir/archive" \
    MY_SKILLS_AUTO_COMMIT=0 \
    ./skill-loom ui --port "$port" >"$tmp_dir/ui.log" 2>&1 &
  UI_PIDS+=($!)

  # Vite 起動は dist 配信より遅いので待ちを伸ばす。
  local attempts=0
  while [ $attempts -lt 60 ]; do
    if curl -s -o /dev/null "http://localhost:${port}/" 2>/dev/null; then
      break
    fi
    sleep 0.5
    attempts=$((attempts + 1))
  done
  if [ $attempts -ge 60 ]; then
    fail "test_vite_direct_api_returns_json_502_not_spa_html: public UI did not start"
    return
  fi

  # ログに Vite ポートが出るまで短く待つ。
  local vite_port=""
  attempts=0
  while [ $attempts -lt 40 ]; do
    vite_port=$(grep -Eo 'Vite dev server on 127\.0\.0\.1:[0-9]+' "$tmp_dir/ui.log" 2>/dev/null \
      | grep -Eo '[0-9]+$' | tail -1 || true)
    if [ -n "$vite_port" ]; then
      break
    fi
    sleep 0.25
    attempts=$((attempts + 1))
  done
  if [ -z "$vite_port" ]; then
    fail "test_vite_direct_api_returns_json_502_not_spa_html: vite port not found in log"
    return
  fi

  local public_code public_ct public_body
  public_code=$(curl -s -o "$tmp_dir/public.json" -w "%{http_code}" \
    -D "$tmp_dir/public.headers" \
    "http://localhost:${port}/api/external-sources" 2>/dev/null || echo "000")
  public_body=$(cat "$tmp_dir/public.json" 2>/dev/null || true)
  public_ct=$(grep -i '^content-type:' "$tmp_dir/public.headers" 2>/dev/null | tr -d '\r' || true)

  [ "$public_code" = "200" ] && assert_contains "$public_body" '"page":"external-sources"' \
    && assert_contains "$public_ct" "application/json" \
    && pass "test_vite_direct_api_returns_json_502_not_spa_html: public port still serves JSON API" \
    || fail "test_vite_direct_api_returns_json_502_not_spa_html: public port broken (HTTP $public_code, ct=$public_ct)"

  local vite_code vite_ct vite_body
  vite_code=$(curl -s -o "$tmp_dir/vite.json" -w "%{http_code}" \
    -D "$tmp_dir/vite.headers" \
    "http://127.0.0.1:${vite_port}/api/external-sources" 2>/dev/null || echo "000")
  vite_body=$(cat "$tmp_dir/vite.json" 2>/dev/null || true)
  vite_ct=$(grep -i '^content-type:' "$tmp_dir/vite.headers" 2>/dev/null | tr -d '\r' || true)

  [ "$vite_code" = "502" ] \
    && pass "test_vite_direct_api_returns_json_502_not_spa_html: vite direct /api returns 502" \
    || fail "test_vite_direct_api_returns_json_502_not_spa_html: expected 502, got HTTP $vite_code (body=$(printf '%.60s' "$vite_body"))"

  assert_contains "$vite_ct" "application/json" \
    && pass "test_vite_direct_api_returns_json_502_not_spa_html: vite direct /api is JSON not HTML" \
    || fail "test_vite_direct_api_returns_json_502_not_spa_html: expected JSON content-type, got [$vite_ct]"

  assert_contains "$vite_body" "Skill Loom UI" \
    && pass "test_vite_direct_api_returns_json_502_not_spa_html: points at public UI" \
    || fail "test_vite_direct_api_returns_json_502_not_spa_html: guidance message missing"

  # 回帰: SPA index を 200 で返さないこと（旧挙動の検知）
  if assert_contains "$vite_body" "<!doctype html>"; then
    fail "test_vite_direct_api_returns_json_502_not_spa_html: vite leaked SPA HTML for /api"
  else
    pass "test_vite_direct_api_returns_json_502_not_spa_html: does not return SPA HTML"
  fi
}

register_cases \
  test_vite_direct_api_returns_json_502_not_spa_html
