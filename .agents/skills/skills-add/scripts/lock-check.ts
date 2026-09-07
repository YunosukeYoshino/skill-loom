#!/usr/bin/env bun
/**
 * lock-check — skills.lock.json / .skills-ignore.json の照会（TypeScript 版）
 *
 * skills-add の shell 内にあった inline スクリプトを置き換える。2 つの照会を提供する。
 *
 * 使い方:
 *   bun lock-check.ts ignore <skill> <ignore-file>   # 'yes' か 'no' を出力
 *   bun lock-check.ts in-lock <skill> <lock-file>    # 'yes' か 'no' を出力
 *   bun lock-check.ts lookup <skill> <lock-file>     # none | custom | vendor | external SOURCE
 */

import fs from "node:fs";
import process from "node:process";

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function isIgnored(skill: string, ignoreFile: string): boolean {
  const data = readJson(ignoreFile) as { ignore?: unknown } | null;
  if (data && Array.isArray(data.ignore)) {
    return data.ignore.includes(skill);
  }
  return false;
}

function isInLock(skill: string, lockFile: string): boolean {
  return lookupLock(skill, lockFile) !== "none";
}

function lookupLock(skill: string, lockFile: string): string {
  const lock = readJson(lockFile) as {
    external?: Record<string, { source?: unknown }>;
    custom?: { skills?: Record<string, unknown> };
    vendor?: Record<string, unknown>;
  } | null;
  if (!lock) return "none";
  if (
    lock.custom?.skills &&
    Object.prototype.hasOwnProperty.call(lock.custom.skills, skill)
  )
    return "custom";
  if (lock.vendor && Object.prototype.hasOwnProperty.call(lock.vendor, skill))
    return "vendor";
  if (
    lock.external &&
    Object.prototype.hasOwnProperty.call(lock.external, skill)
  ) {
    const source = lock.external[skill]?.source;
    return typeof source === "string" && source !== ""
      ? `external ${source}`
      : "external";
  }
  return "none";
}

function main(): void {
  const [command, skill, file] = process.argv.slice(2);
  if (file === undefined || skill === undefined) {
    console.error(
      "Error: usage: lock-check.ts <ignore|in-lock|lookup> <skill> <file>"
    );
    process.exit(2);
  }
  if (command === "ignore") {
    process.stdout.write(isIgnored(skill, file) ? "yes\n" : "no\n");
    return;
  }
  if (command === "in-lock") {
    process.stdout.write(isInLock(skill, file) ? "yes\n" : "no\n");
    return;
  }
  if (command === "lookup") {
    process.stdout.write(`${lookupLock(skill, file)}\n`);
    return;
  }
  console.error(`Error: unknown command: ${command}`);
  process.exit(2);
}

if (import.meta.main) {
  main();
}
