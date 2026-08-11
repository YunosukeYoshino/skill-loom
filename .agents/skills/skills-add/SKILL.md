---
name: skills-add
description: "外部スキルを GitHub からインストールし skills.lock.json に自動登録する。skillPath を GitHub API で解決し .skills-ignore.json を尊重する。トリガー: /skills-add <url-or-owner/repo>"
---

# Skills Add

external Skill の取得から selected Catalog の Inventory Lock 更新・コミットまでを自動化する。

## Arguments

- `$0` = GitHub URL または `owner/repo` 形式
- `MY_SKILLS_CATALOG_DIR` = 更新対象 Catalog
- `--skill <name>` = 特定のスキルのみインストール（省略時は repo 内全スキル）
- `--no-commit` = lock.json 更新のみ、コミットしない

`$ARGUMENTS` が空の場合はユーザーに URL を質問する。

## Workflow

### Step 1: 引数を確認

`$ARGUMENTS` から URL を抽出する。空なら質問:

- インストールしたい external skill の GitHub URL または `owner/repo` を教えてください

### Step 2: スクリプトを実行

```bash
MY_SKILLS_CATALOG_DIR="$CATALOG_ROOT" \
  bash "$ENGINE_ROOT/.agents/skills/skills-add/scripts/skills-add" $ARGUMENTS
```

スクリプトが自動的に以下を処理する:

- `npx skills add` でインストール
- 対象 agent は `claude-code`、`codex`、`antigravity`
- インストール前後の差分で新規スキルを検出
- GitHub API で各 SKILL.md の frontmatter `name` を突合して `skillPath` を解決
- `.skills-ignore.json` に含まれるスキルはスキップ
- Catalog の `skills.lock.json` に追記
- デフォルトで Catalog repository にコミット（`--no-commit` でスキップ）

### Step 3: 完了報告

登録されたスキル名・`source`・`skillPath` を出力してユーザーに報告する。

## Troubleshooting

**`gh: command not found`**

```bash
brew install gh && gh auth login
```

**skillPath がパターンマッチにフォールバックした場合**

スクリプトが `skills/<name>/SKILL.md` をデフォルトとして使用した旨の Warning が表示される。
実際の GitHub repo を確認して手動で修正:

```bash
# "$CATALOG_ROOT/skills.lock.json" の skillPath を修正
```

**既に登録済みのスキルを上書きしたい場合**

Catalog の `skills.lock.json` から該当エントリを外して再実行する。
