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
- `--as <alias>` = 展開名・エイリアスを指定（`--skill` 1件指定時のみ利用可能。kebab-case、スラッシュ不可）
- `--prefix` = 衝突がなくても `{owner}--{name}` で登録する
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
- 既存スキルとの同名衝突時は `--as <alias>` / `--prefix` / 自動名前空間（`owner--name`）を適用し、`SKILL.md` の frontmatter `name` も展開名と同期する。対話時は namespace / custom alias / Vendor fork / skip。同一 source の再 add は skip。エージェント symlink は展開名だけ残す
- Catalog の `skills.lock.json` に追記（キーを展開名とし、上流スキル名は `installSkill` に記録）
- デフォルトで Catalog repository にコミット（`--no-commit` でスキップ）

完了基準: スクリプトが exit 0 で終了し、`skills.lock.json` に新規スキルが追記されていること。追記前に、取得元（source・sourceUrl）、解決済み `skillPath`、インストールされた SKILL.md が期待したスキルであるかを検証し、検証に失敗した場合は lock への登録と成功報告を行わないこと。

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
