#!/usr/bin/env bun
/**
 * restore-lock — skills.lock.json に基づいて外部スキルをインストールする（TypeScript 版）
 *
 * 既定: 表示用コマンド行を stdout に出す（dry-run / ログ向け。値は shell クォート済み）。
 * --install: npx を引数配列で直接実行し、shell 経由の注入を避ける。
 *
 * 使い方:
 *   bun restore-lock.ts LOCK_FILE
 *   bun restore-lock.ts --install LOCK_FILE
 */

import fs from "node:fs"
import process from "node:process"

interface ExternalSkillMeta {
  source?: unknown
  installSkill?: unknown
}

const FLAGS = ["-g", "-a", "claude-code", "-a", "codex", "-a", "antigravity", "-y"] as const

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function loadPlans(lockPath: string): Array<{ source: string; skills: string[] }> {
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

  return [...bySource.keys()].sort().map((source) => ({
    source,
    skills: [...new Set(bySource.get(source) ?? [])].sort(),
  }))
}

function buildArgs(source: string, skills: string[]): string[] {
  const skillArgs = skills.flatMap((skill) => ["--skill", skill])
  return ["skills", "add", source, ...skillArgs, ...FLAGS]
}

function main(): void {
  const argv = process.argv.slice(2)
  const install = argv[0] === "--install"
  const lockPath = install ? argv[1] : argv[0]
  if (lockPath === undefined) {
    console.error("Error: restore-lock requires LOCK_FILE")
    process.exit(2)
  }

  const plans = loadPlans(lockPath)
  for (const plan of plans) {
    const args = buildArgs(plan.source, plan.skills)
    const display = ["npx", ...args].map(shellQuote).join(" ")
    process.stdout.write(`${display}\n`)
    if (!install) continue

    const result = Bun.spawnSync(["npx", ...args], { stdout: "inherit", stderr: "inherit" })
    if ((result.exitCode ?? 1) !== 0) {
      process.exit(result.exitCode ?? 1)
    }
  }
}

if (import.meta.main) {
  main()
}
