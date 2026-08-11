#!/usr/bin/env bun
/**
 * lock-check — skills.lock.json / .skills-ignore.json の照会（TypeScript 版）
 *
 * skills-add の shell 内 inline python3 を置き換える。2 つの照会を提供する。
 *
 * 使い方:
 *   bun lock-check.ts ignore <skill> <ignore-file>   # 'yes' か 'no' を出力
 *   bun lock-check.ts in-lock <skill> <lock-file>    # 'yes' か 'no' を出力
 */

import fs from "node:fs"
import process from "node:process"

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}

function isIgnored(skill: string, ignoreFile: string): boolean {
  const data = readJson(ignoreFile) as { ignore?: unknown } | null
  if (data && Array.isArray(data.ignore)) {
    return data.ignore.includes(skill)
  }
  return false
}

function isInLock(skill: string, lockFile: string): boolean {
  const lock = readJson(lockFile) as
    | { external?: Record<string, unknown>; custom?: { skills?: Record<string, unknown> }; vendor?: Record<string, unknown> }
    | null
  if (!lock) return false
  if (lock.external && Object.prototype.hasOwnProperty.call(lock.external, skill)) return true
  if (lock.custom?.skills && Object.prototype.hasOwnProperty.call(lock.custom.skills, skill)) return true
  if (lock.vendor && Object.prototype.hasOwnProperty.call(lock.vendor, skill)) return true
  return false
}

function main(): void {
  const [command, skill, file] = process.argv.slice(2)
  if (file === undefined || skill === undefined) {
    console.error("Error: usage: lock-check.ts <ignore|in-lock> <skill> <file>")
    process.exit(2)
  }
  let result: boolean
  if (command === "ignore") {
    result = isIgnored(skill, file)
  } else if (command === "in-lock") {
    result = isInLock(skill, file)
  } else {
    console.error(`Error: unknown command: ${command}`)
    process.exit(2)
  }
  process.stdout.write(result ? "yes\n" : "no\n")
}

if (import.meta.main) {
  main()
}