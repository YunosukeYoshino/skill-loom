#!/usr/bin/env bun
/**
 * sync-skill-name — SKILL.md の frontmatter 内の name を指定の名前に同期・置換する
 *
 * 使い方:
 *   bun sync-skill-name.ts <skill-md-path> <new-name>
 */

import fs from "node:fs";
import process from "node:process";

function syncFrontmatterName(filePath: string, newName: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, "utf-8");
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
  fs.writeFileSync(tmpPath, newLines.join("\n"));
  fs.renameSync(tmpPath, filePath);
  return true;
}

function main(): void {
  const [filePath, newName] = process.argv.slice(2);
  if (!filePath || !newName) {
    console.error("Error: sync-skill-name requires <skill-md-path> <new-name>");
    process.exit(2);
  }

  try {
    const success = syncFrontmatterName(filePath, newName);
    if (!success) {
      console.error(`Error: failed to sync frontmatter name in ${filePath}`);
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
