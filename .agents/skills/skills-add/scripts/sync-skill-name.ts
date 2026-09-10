#!/usr/bin/env bun
/**
 * sync-skill-name — SKILL.md の frontmatter 内の name を指定の名前に同期・置換する
 *
 * 使い方:
 *   bun sync-skill-name.ts <skill-md-path> <new-name>
 */

import process from "node:process";
import { syncSkillMdName } from "../../../../app/backend/domain/skillMd";

function main(): void {
  const [filePath, newName] = process.argv.slice(2);
  if (!filePath || !newName) {
    console.error("Error: sync-skill-name requires <skill-md-path> <new-name>");
    process.exit(2);
  }

  try {
    const success = syncSkillMdName(filePath, newName);
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
