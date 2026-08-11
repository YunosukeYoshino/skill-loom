#!/usr/bin/env bun
/**
 * restore-lock — skills.lock.json に基づいて外部スキルのインストールコマンドを生成する（TypeScript 版）
 *
 * Python 版 restore-lock.py を挙動互換で置き換える。CLI 契約（stdout・stderr・exit code）は不変。
 *
 * 使い方:
 *   bun restore-lock.ts LOCK_FILE
 */

import fs from "node:fs"
import process from "node:process"

interface ExternalSkillMeta {
  source?: unknown
  installSkill?: unknown
}

const FLAGS = "-g -a claude-code -a codex -a antigravity -y"

function main(): void {
  const lockPath = process.argv[2]
  if (lockPath === undefined) {
    console.error("Error: restore-lock requires LOCK_FILE")
    process.exit(2)
  }

  let lock: { external?: Record<string, ExternalSkillMeta> }
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { external?: Record<string, ExternalSkillMeta> }
  } catch {
    console.error(`Error: Cannot read or parse lock file: ${lockPath}`)
    process.exit(1)
  }

  const bySource = new Map<string, string[]>()
  for (const [name, meta] of Object.entries(lock.external ?? {})) {
    const source = meta?.source
    if (typeof source !== "string" || source === "") {
      console.error(`Warning: skipping external skill '${name}': missing source`)
      continue
    }
    const installName = typeof meta?.installSkill === "string" ? meta.installSkill : name
    const list = bySource.get(source) ?? []
    list.push(installName)
    bySource.set(source, list)
  }

  for (const source of [...bySource.keys()].sort()) {
    const skills = [...new Set(bySource.get(source) ?? [])].sort()
    const skillArgs = skills.map((s) => `--skill ${s}`).join(" ")
    process.stdout.write(`npx skills add ${source} ${skillArgs} ${FLAGS}\n`)
  }
}

if (import.meta.main) {
  main()
}