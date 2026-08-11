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

import process from "node:process"
import { updateInventoryLock, type LockObject } from "./update-inventory-lock"

type ExternalEntry = { source: string; sourceUrl: string; skillPath: string }

type LockFile = LockObject & {
  external?: Record<string, ExternalEntry>
}

function main(): void {
  const [lockPath, skillName, source, sourceUrl, skillPath] = process.argv.slice(2)
  if (!lockPath || !skillName || !source || !sourceUrl || !skillPath) {
    console.error("Error: register-skill-lock requires LOCK_FILE SKILL_NAME SOURCE SOURCE_URL SKILL_PATH")
    process.exit(2)
  }

  try {
    updateInventoryLock(lockPath, (raw) => {
      const lock = raw as LockFile
      if (lock.external === undefined) {
        lock.external = {}
      } else if (
        typeof lock.external !== "object" ||
        lock.external === null ||
        Array.isArray(lock.external)
      ) {
        throw new Error(`Lock file external section must be an object: ${lockPath}`)
      }
      lock.external[skillName] = { source, sourceUrl, skillPath }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${message}`)
    process.exit(1)
  }

  process.stdout.write("  -> Registered in skills.lock.json\n")
}

if (import.meta.main) {
  main()
}
