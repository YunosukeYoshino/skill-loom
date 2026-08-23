---
name: vendor-fork
description: "外部skillをフォークしてカスタマイズ (description日本語化等) する。upstream原本の保存、vendor/への配置、対話的な編集、インストールまで実行。トリガー: /vendor-fork {skill-name}"
---

# Vendor Fork

外部skillをフォークし、カスタマイズ版を作成・インストールするワークフロー。

最初に `CATALOG_ROOT` を選び、以後の Inventory／Vendor／Upstream／Git 操作をその Catalog に閉じ込める。

## Arguments

- `$0` = フォーク対象の外部skill名

`$ARGUMENTS` が空の場合、インストール済みの外部skillを一覧表示してユーザーに選択させる。

## Workflow

### Step 1: 対象の確認

対象skillが外部skillであることを確認:

```bash
# .skill-lock.json で source が my-skills でないことを確認
bun "$ENGINE_ROOT/.agents/skills/vendor-fork/scripts/lock-lookup.ts" \
  global-source '{skill-name}'
```

既に `$CATALOG_ROOT/vendor/{skill-name}` が存在する場合はエラー。

### Step 2: upstream と vendor にコピー

```bash
bash "$ENGINE_ROOT/.agents/skills/vendor-fork/scripts/skills-vendor-fork" \
  --catalog-dir "$CATALOG_ROOT" {skill-name}
```

完了基準: `$CATALOG_ROOT/vendor/{skill-name}` と `$CATALOG_ROOT/upstream/{skill-name}` の両方が作成されていること。

### Step 3: 対話的なカスタマイズ

ユーザーに何をカスタマイズしたいか質問:

- **description 日本語化**: description フィールドを日本語に翻訳
- **トリガー条件の追加**: 日本語のトリガーワードを追加
- **body の編集**: 手順や説明の修正
- **その他**: 自由編集

カスタマイズ内容に応じて `$CATALOG_ROOT/vendor/{skill-name}/SKILL.md` を編集。

frontmatter ルール (CLAUDE.md 準拠):

- `name` と `description` のみ
- YAML特殊文字はクォート必須

完了基準: 編集後の `vendor/{skill-name}/SKILL.md` が frontmatter ルールを満たしていること。

### Step 4: skills.lock.json 更新

Catalog の `skills.lock.json` の `vendor` セクションに追加:

```json
"{skill-name}": {
  "source": "{source repo}"
}
```

完了基準: `skills.lock.json` の `vendor` セクションに `{skill-name}` が source 付きで追加されていること。

### Step 5: Catalog commit

```bash
git -C "$CATALOG_ROOT" add vendor/{skill-name} upstream/{skill-name} skills.lock.json
git -C "$CATALOG_ROOT" commit -m "feat: vendor {skill-name}"
```

完了基準: commit に Vendor、Upstream、Inventory Lock の3つが含まれること。

### Step 6: インストール (上書き)

```bash
CUSTOM_REPO=$(bun "$ENGINE_ROOT/.agents/skills/skills-restore/scripts/lock-repo.ts" \
  "$CATALOG_ROOT/skills.lock.json")
bunx skills add "$CUSTOM_REPO" --skill {skill-name} -g -a claude-code -a codex -a antigravity -y
```

外部版がカスタマイズ版で上書きされる。

完了基準: `bunx skills add` が正常終了し、`~/.agents/skills/{skill-name}` がカスタマイズ版に置き換わり、`~/.claude/skills/{skill-name}` もカスタマイズ版を参照していること（symlink またはコピー）。

### Step 7: 完了報告

- フォーク元: {source}
- カスタマイズ内容
- upstream 更新後は Catalog-aware な sync → audit の順で差分を確認したこと

## Audit (更新時)

外部skillがアップデートされた後の確認フロー:

```bash
bunx skills update
bash "$ENGINE_ROOT/.agents/skills/vendor-fork/scripts/skills-sync-upstream" --catalog-dir "$CATALOG_ROOT"
bash "$ENGINE_ROOT/.agents/skills/vendor-fork/scripts/skills-audit-vendor" --catalog-dir "$CATALOG_ROOT"
```

差分がある場合、ユーザーに以下を提示:

1. upstream の変更内容 (diff)
2. マージ提案 (カスタマイズを維持しつつ upstream の変更を取り込み)
3. ユーザー確認後に vendor/ を更新
