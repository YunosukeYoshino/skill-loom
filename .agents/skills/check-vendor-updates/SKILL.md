---
name: check-vendor-updates
description: "skills.lock.json 管理スキルの upstream 更新を事前確認し、未管理スキルも検出する。bunx skills check/update 前に更新有無や未登録スキルを棚卸ししたい時に使用。トリガー: 「vendor 更新確認」「lock 更新確認」「skills update 前に確認」「未管理スキルをチェック」「lock.json 棚卸し」"
---

# Check Vendor Updates

selected Catalog の External Skill について upstream 更新と未管理 Skill を棚卸しする。

## Why this skill

`bunx skills update` は不可逆で重い。この skill はその実行前に、(1) lock.json 管理 external スキルの upstream 更新有無、(2) インストール済みだが `skills.lock.json` に未登録のスキル、を検出して判断材料を提供する。

## Workflow

### Step 1: Engine と Catalog の確定

```bash
export MY_SKILLS_CATALOG_DIR="$CATALOG_ROOT"
test -f "$CATALOG_ROOT/skills.lock.json"
```

完了基準: `MY_SKILLS_CATALOG_DIR` が設定され、`skills.lock.json` の存在が確認できていること。

### Step 2: skills.lock.json の external スキル一覧を取得

```bash
bun "$ENGINE_ROOT/.agents/skills/check-vendor-updates/scripts/check-vendor-updates.ts" --catalog-dir "$CATALOG_ROOT"
```

完了基準: external スキル名の一覧と件数が出力されていること。

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

完了基準: `/tmp/skills-check.txt` が生成され、更新ありスキル名の抽出が済んでいること（0 件なら空でよい）。

### Step 4: lock.json external スキルとのクロスリファレンス

Step 2 と同じスクリプトを再実行する。同スクリプトは external 一覧・更新クロスリファレンス・未管理スキルの棚卸しをまとめて出力し、クロスリファレンスには Step 3 の `/tmp/skills-check.txt` が必要。

完了基準: 「更新あり (lock管理)」と「更新あり (未管理)」の件数が出力されていること。

### Step 5: 未管理スキルの棚卸し（source 付き）

Step 4 と同じ出力の「未管理スキル」セクションを使う。インストール済みだが `skills.lock.json` にも `.skills-ignore.json` にも含まれないスキルを、`~/.agents/.skill-lock.json` から引いた source 付きで検出する。

完了基準: 未管理スキルごとに source 付きの一覧、または「未管理スキルはありません」が出力されていること。

### Step 6: vendor 管理スキル一覧の取得

```bash
ls -d "$CATALOG_ROOT/vendor/"*/ 2>/dev/null | sed "s|$CATALOG_ROOT/vendor/||;s|/||" | sort
```

`vendor/` が空または `.gitkeep` のみの場合はスキップ。

完了基準: vendor スキル名の一覧、または `vendor/` が空であることの判定を得ていること。

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

完了基準: 全 vendor スキルについて「更新あり／最新」の判定が出ていること。

### Step 8: 結果のレポート

以下の形式でユーザーに提示:

```
🔍 skills.lock.json 更新・棚卸し結果

📦 lock.json 管理スキルで更新あり: 3 件
  ✅ agent-browser      vercel-labs/agent-browser
  ...

⚠️  更新ありだが lock.json 未管理: 6 件
  lead-magnets          coreyhaines31/marketingskills
  ...

🔍 lock.json 未管理のインストール済みスキル: 6 件
  ❓ lead-magnets          coreyhaines31/marketingskills
  ...

📦 vendor 管理スキル:
  ✅ prisma-cli → 最新
  （vendor/ が空の場合はセクション自体を省略）

→ lock.json external 全体: 56 件
→ 更新あり (lock管理): 3 件
→ 更新あり (未管理): 6 件
→ 未管理スキル: 6 件
```

完了基準: 4 分類（lock管理の更新・未管理の更新・未管理インストール済み・vendor）を判定し、該当する分類をレポートに含めていること（vendor/ が空の場合は vendor 分類を省略する）。

### Step 9: ユーザーへのアクション提案

検出結果に応じて以下を提案:

**更新がある場合:**

> upstream 更新があります。更新しますか？
>
> - **yes**: `bunx skills update` → Catalog-aware sync → audit を順次実行
> - **no**: 現状維持
> - **select**: 特定のスキルだけ更新

**未管理スキルがある場合:**

> lock.json に未登録のスキルが {N} 件あります。
>
> - `/skills-add <owner/repo>` で lock.json に登録
> - `.skills-ignore.json` に追加して明示的に無視

完了基準: 検出した項目について提案を提示し、必要な場合はユーザーの次の指示を得ていること（該当なしの分類への提案は不要）。

## 注意

- `bunx skills check -g` は**実際に更新を実行する**。副作用があることをユーザーに事前に伝えること
- 133 件のチェックには数分かかるため、実行前に待ち時間を伝えること
- `bunx skills update` は `--skill` で個別指定が可能
- Vendor 更新後は `$ENGINE_ROOT/.agents/skills/vendor-fork/scripts/skills-sync-upstream --catalog-dir "$CATALOG_ROOT"` → audit の順で実行すること
