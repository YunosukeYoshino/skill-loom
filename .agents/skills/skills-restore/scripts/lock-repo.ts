#!/usr/bin/env bun
/**
 * lock-repo — skills.lock.json からカスタムリポジトリ名を取得する（TypeScript 版）
 *
 * Python 版 lock-repo.py を挙動互換で置き換える。CLI 契約は不変。
 *
 * 使い方:
 *   bun lock-repo.ts LOCK_FILE
 */

import fs from "node:fs";
import process from "node:process";

function main(): void {
  const lockPath = process.argv[2];
  if (lockPath === undefined) {
    console.error("Error: lock-repo requires LOCK_FILE");
    process.exit(2);
  }

  let lock: { custom?: { repo?: unknown } };
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
      custom?: { repo?: unknown };
    };
  } catch {
    console.error(`Error: Cannot read or parse lock file: ${lockPath}`);
    process.exit(1);
  }

  const repo = lock.custom?.repo;
  if (typeof repo !== "string") {
    console.error("Error: lock.custom.repo is missing");
    process.exit(1);
  }
  process.stdout.write(`${repo}\n`);
}

if (import.meta.main) {
  main();
}
