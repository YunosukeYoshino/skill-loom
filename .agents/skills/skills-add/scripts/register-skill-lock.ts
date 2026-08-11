#!/usr/bin/env bun
/**
 * register-skill-lock — スキルを skills.lock.json の external セクションに登録する（TypeScript 版）
 *
 * Python 版 register-skill-lock.py を挙動互換で置き換える。
 * コマンドライン契約（args・stdout・JSON 変異・アトミック書き込み）は不変。
 *
 * 使い方:
 *   bun register-skill-lock.ts LOCK_FILE SKILL_NAME SOURCE SOURCE_URL SKILL_PATH
 */

import fs from "node:fs"
import process from "node:process"

type LockFile = {
  external?: Record<string, { source: string; sourceUrl: string; skillPath: string }>
  [key: string]: unknown
}

function main(): void {
  const [lockPath, skillName, source, sourceUrl, skillPath] = process.argv.slice(2)
  if (!lockPath || !skillName || !source || !sourceUrl || !skillPath) {
    console.error("Error: register-skill-lock requires LOCK_FILE SKILL_NAME SOURCE SOURCE_URL SKILL_PATH")
    process.exit(2)
  }

  let lock: LockFile
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockFile
  } catch {
    console.error(`Error: Cannot read or parse lock file: ${lockPath}`)
    process.exit(1)
  }

  if (typeof lock !== "object" || lock === null || Array.isArray(lock)) {
    console.error(`Error: Lock file is not a JSON object: ${lockPath}`)
    process.exit(1)
  }

  if (typeof lock.external !== "object" || lock.external === null) {
    lock.external = {}
  }

  lock.external[skillName] = { source, sourceUrl, skillPath }

  const tmp = `${lockPath}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`)
  fs.renameSync(tmp, lockPath)
  process.stdout.write("  -> Registered in skills.lock.json\n")
}

if (import.meta.main) {
  main()
}