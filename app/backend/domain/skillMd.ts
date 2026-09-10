/**
 * SKILL.md の YAML frontmatter `name:` を、展開先ディレクトリ名に揃える。
 *
 * エージェントはフォルダ名と frontmatter の name を突き合わせる。エイリアスや
 * `{owner}--{name}` へ移したあと、ここを同期しないと別スキルとして解決される。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function syncSkillMdName(filePath: string, newName: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") {
    return false;
  }

  let inFrontmatter = false;
  let replaced = false;
  const newLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      newLines.push(line);
      continue;
    }
    if (inFrontmatter && line.trim() === "---") {
      if (!replaced) {
        newLines.push(`name: ${newName}`);
        replaced = true;
      }
      inFrontmatter = false;
      newLines.push(line);
      continue;
    }
    if (inFrontmatter && /^name\s*:\s*.*$/.test(line)) {
      newLines.push(`name: ${newName}`);
      replaced = true;
      continue;
    }
    newLines.push(line);
  }

  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, newLines.join("\n"));
    renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}
