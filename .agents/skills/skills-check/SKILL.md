---
name: skills-check
description: "skills.lock.json とインストール済みスキルの整合性を確認する。欠落・余剰・未管理スキルを検出。トリガー: 「スキルの整合性」「lockとインストールの確認」「スキルチェック」"
---

# Skills Check

selected Catalog の Inventory Lock／ignore と、agent-facing Projection を照合する。

## 実行

```bash
MY_SKILLS_CATALOG_DIR="$CATALOG_ROOT" \
  bash "$ENGINE_ROOT/.agents/skills/skills-check/scripts/skills-check"
```

完了条件: 出力に Issues、Unmanaged、欠落場所がすべて列挙されていること。

## スクリプトが出力する分類

| 分類 | 意味 |
|------|------|
| CUSTOM | Catalog 由来の Custom／Vendor Skill |
| EXTERNAL | 外部repo由来のスキル（sourceごとにグループ化） |
| IGNORED | `.skills-ignore.json` で明示的に除外済み |
| UNMANAGED | lock にも ignore にもない未知スキル |

## Issues

各スキルについて `~/.agents/skills/` または `~/.claude/skills/` のいずれかに欠落があれば `!! NO ...` マークが付く。

## ユーザーへの報告

実行後、以下をユーザーに報告:
1. Issues 件数（0なら "ALL CLEAN"）
2. UNMANAGED スキルがあれば、`/skills-add` で lock 登録するか `.skills-ignore.json` で除外を提案
3. 欠落があれば `/skills-restore` での修復を提案
