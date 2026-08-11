#!/usr/bin/env bun
/**
 * resolve-skill-path — GitHub リポジトリツリーから SKILL.md の name を照合し skillPath を解決する（TypeScript 版）
 *
 * Python 版 resolve-skill-path.py を挙動互換で置き換える。
 * コマンドライン契約（env 入力・stdout・exit code）は不変。
 *
 * 環境変数:
 *   TREE_FILE    — リポジトリツリーJSONのパス
 *   SKILL_NAME   — 検索するスキル名
 *   OWNER_REPO   — owner/repo 形式のリポジトリ指定
 */

import process from "node:process";
import fs from "node:fs";

interface TreeItem {
  path?: string;
  type?: string;
}

interface GhContentResponse {
  content?: string;
}

/**
 * リポジトリツリーから SKILL.md の blob パスを集める。
 */
function skillMdPaths(tree: { tree?: TreeItem[] }): string[] {
  const items = tree.tree ?? [];
  return items
    .filter(
      (item) => item.type === "blob" && (item.path ?? "").endsWith("SKILL.md")
    )
    .map((item) => item.path as string);
}

/**
 * フロントマター内の name フィールドを返す。SKILL.md の実体を解析し、
 * 見つからない場合は null を返す。Python 版の frontmatter 走査と同じ意味論。
 */
function frontmatterName(raw: string): string | null {
  let inFm = false;
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "---") {
      if (!inFm) {
        inFm = true;
      } else {
        break;
      }
    } else if (inFm && stripped.startsWith("name:")) {
      return stripped
        .replace(/^name:\s*/, "")
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

/**
 * gh api で SKILL.md の content を取得し、base64 デコード後の文字列を返す。
 * gh が失敗する場合は null を返す（Python 版の try/except continue と同義）。
 */
function fetchSkillContent(ownerRepo: string, path: string): string | null {
  const result = Bun.spawnSync(
    ["gh", "api", `repos/${ownerRepo}/contents/${path}`],
    { stdout: "pipe", stderr: "pipe", timeout: 15000 }
  );
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.toString()) as GhContentResponse;
    if (typeof parsed.content !== "string") return null;
    return Buffer.from(parsed.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

function main(): void {
  const treeFile = process.env.TREE_FILE;
  const skillName = process.env.SKILL_NAME;
  const ownerRepo = process.env.OWNER_REPO;
  if (
    treeFile === undefined ||
    skillName === undefined ||
    ownerRepo === undefined
  ) {
    console.error("Error: TREE_FILE, SKILL_NAME, OWNER_REPO are required");
    process.exit(2);
  }

  let tree: { tree?: TreeItem[] };
  try {
    tree = JSON.parse(fs.readFileSync(treeFile, "utf-8")) as {
      tree?: TreeItem[];
    };
  } catch {
    process.exit(1);
  }

  for (const path of skillMdPaths(tree)) {
    const raw = fetchSkillContent(ownerRepo, path);
    if (raw === null) continue;
    if (frontmatterName(raw) === skillName) {
      process.stdout.write(`${path}\n`);
      process.exit(0);
    }
  }

  process.exit(1);
}

if (import.meta.main) {
  main();
}
