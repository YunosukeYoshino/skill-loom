---
name: check-vendor-updates
description: "skills.lock.json 管理スキルの upstream 更新を事前確認し、未管理スキルも検出する。bunx skills check/update 前に更新有無や未登録スキルを棚卸ししたい時に使用。トリガー: 「vendor 更新確認」「lock 更新確認」「skills update 前に確認」「未管理スキルをチェック」「lock.json 棚卸し」"
---

# Check Vendor Updates

selected Catalog の External Skill について upstream 更新と未管理 Skill を棚卸しする。

## Why this skill

以下の2つの問題を `bunx skills update` 実行前に検出する:

1. **更新検出**: lock.json 管理 external スキルの upstream 更新有無を事前確認
2. **未管理検出**: インストール済みだが `skills.lock.json` に未登録のスキルを検出

既存フローは `bunx skills update` が不可逆なため重い。この skill はその前に判断材料を提供する。

## Workflow

### Step 1: Engine と Catalog の確定

```bash
export MY_SKILLS_CATALOG_DIR="$CATALOG_ROOT"
test -f "$CATALOG_ROOT/skills.lock.json"
```

### Step 2: skills.lock.json の external スキル一覧を取得

```bash
bun "$ENGINE_ROOT/.agents/skills/check-vendor-updates/scripts/check-vendor-updates.ts" --catalog-dir "$CATALOG_ROOT"
```

### Step 3: bunx skills check -g で更新を実行し結果を記録

```bash
# 全グローバルスキルの更新チェック（時間がかかるためユーザーに待ち時間を伝える）
# ※ このコマンドは実際に更新を実行する副作用がある
bunx skills check -g 2>&1 | tee /tmp/skills-check.txt
```

出力から更新があったスキル名を抽出（ANSI escape code を strip してから grep）:

```bash
# ANSI escape codes を除去してからパース（数字始まりのサマリー行を除外）
sed 's/\x1b\[[0-9;]*m//g' /tmp/skills-check.txt | grep '✓ Updated' | awk '{print $3}' | grep -E '^[a-z][a-z0-9-]*$'
```

### Step 4: lock.json external スキルとのクロスリファレンス

```bash
bun "$ENGINE_ROOT/.agents/skills/check-vendor-updates/scripts/check-vendor-updates.ts" --catalog-dir "$CATALOG_ROOT"
```

上記のコマンドは Step 2 / Step 4 / Step 5 の棚卸し（external 一覧・更新クロスリファレンス・未管理スキル）をまとめて出力する。`/tmp/skills-check.txt` は Step 3 の `bunx skills check -g` の出力が必要。

### Step 5: 未管理スキルの棚卸し（source 付き）

インストール済みだが `skills.lock.json` にも `.skills-ignore.json` にも含まれないスキルを検出。可能であれば `~/.agents/.skill-lock.json` から source も引く:

```bash
bun "$ENGINE_ROOT/.agents/skills/check-vendor-updates/scripts/check-vendor-updates.ts" --catalog-dir "$CATALOG_ROOT"
```

### Step 6: vendor 管理スキル一覧の取得

```bash
ls -d "$CATALOG_ROOT/vendor/"*/ 2>/dev/null | sed "s|$CATALOG_ROOT/vendor/||;s|/||" | sort
```

`vendor/` が空または `.gitkeep` のみの場合はスキップ。

### Step 7: vendor スキルと更新リストのクロスリファレンス

```bash
vendor_names=$(ls -d "$CATALOG_ROOT/vendor/"*/ 2>/dev/null | sed "s|$CATALOG_ROOT/vendor/||;s|/||" | sort)
updatable=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/skills-check.txt | grep '✓ Updated' | awk '{print $3}' | grep -E '^[a-z][a-z0-9-]*$' || true)

has_update=false
for name in $vendor_names; do
  if echo "$updatable" | grep -qx "$name"; then
    echo "📦 $name → upstream 更新あり"
    has_update=true
  else
    echo "✅ $name → 最新"
  fi
done
```

### Step 8: 結果のレポート

以下の形式でユーザーに提示:

```
🔍 skills.lock.json 更新・棚卸し結果

📦 lock.json 管理スキルで更新あり: 3 件
  ✅ agent-browser      vercel-labs/agent-browser
  ✅ browser-use        browser-use/browser-use
  ✅ seo-audit          seo-skills/seo-audit-skill

⚠️  更新ありだが lock.json 未管理: 6 件
  lead-magnets          coreyhaines31/marketingskills
  marketing-psychology  coreyhaines31/marketingskills
  ...

🔍 lock.json 未管理のインストール済みスキル: 6 件
  ❓ lead-magnets          coreyhaines31/marketingskills
  ❓ marketing-psychology  coreyhaines31/marketingskills
  ...

📦 vendor 管理スキル:
  ✅ prisma-cli → 最新
  （vendor/ が空の場合はセクション自体を省略）

→ lock.json external 全体: 56 件
→ 更新あり (lock管理): 3 件
→ 更新あり (未管理): 6 件
→ 未管理スキル: 6 件
```

### Step 9: ユーザーへのアクション提案

検出結果に応じて以下を提案:

**更新がある場合:**
> upstream 更新があります。更新しますか？
> - **yes**: `bunx skills update` → Catalog-aware sync → audit を順次実行
> - **no**: 現状維持
> - **select**: 特定のスキルだけ更新

**未管理スキルがある場合:**
> lock.json に未登録のスキルが {N} 件あります。
> - `/skills-add <owner/repo>` で lock.json に登録
> - `.skills-ignore.json` に追加して明示的に無視

## 注意

- `bunx skills check -g` は**実際に更新を実行する**。副作用があることをユーザーに事前に伝えること
- 133 件のチェックには数分かかるため、実行前に待ち時間を伝えること
- `bunx skills update` は `--skill` で個別指定が可能
- Vendor 更新後は `$ENGINE_ROOT/.agents/skills/vendor-fork/scripts/skills-sync-upstream --catalog-dir "$CATALOG_ROOT"` → audit の順で実行すること
