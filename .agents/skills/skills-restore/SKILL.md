---
name: skills-restore
description: "skills.lock.json から全スキルを一括リストアする。--clean で既存スキルを退避後まっさらに再構築、--dry-run でプレビュー。トリガー: 「スキルをリストア」「スキルを復元」「リストア」「restore」"
---

# Skills Restore

selected Catalog の Inventory Lock を正として、External → Custom／Vendor → Agent 定義の順に Projection を再構築する。

## 実行

```bash
# 通常リストア（冪等 — 既存の上から実行しても安全）
bash "$ENGINE_ROOT/.agents/skills/skills-restore/scripts/skills-restore" --catalog-dir "$CATALOG_ROOT"

# 既存スキルを退避してからまっさらにリストア
bash "$ENGINE_ROOT/.agents/skills/skills-restore/scripts/skills-restore" --catalog-dir "$CATALOG_ROOT" --clean

# 変更を加えずプレビュー
bash "$ENGINE_ROOT/.agents/skills/skills-restore/scripts/skills-restore" --catalog-dir "$CATALOG_ROOT" --clean --dry-run
```

## --clean で退避したスナップショットのロールバック

```bash
# 利用可能なアーカイブ一覧
ls ~/.agents/skills-archive/

# ロールバック
bash "$ENGINE_ROOT/.agents/skills/skills-restore/scripts/skills-rollback" <timestamp>
```

## 処理の流れ

1. **外部スキル**: lock の `external` セクションを source ごとにグループ化し `bunx skills add` で `claude-code`、`codex`、`antigravity` にインストール
2. **Custom／Vendor**: Lock の `custom.repo` を `bunx skills add` でインストール（External を上書き）
3. **Agent 定義**: Catalog の `agents/` を `~/.claude/agents/` にコピー

## ユーザーへの報告

実行後、インストールされたスキル一覧と合計件数を報告する。`--clean` 使用時は退避先パスとロールバック手順も案内する。
