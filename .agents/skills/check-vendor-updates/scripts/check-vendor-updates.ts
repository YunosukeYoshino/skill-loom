#!/usr/bin/env bun
/**
 * check-vendor-updates — upstream 更新と未管理スキルの棚卸し（TypeScript 版）
 *
 * check-vendor-updates SKILL.md の inline スクリプトを置き換える。3 つの棚卸しをまとめて出力する。
 * 期待される /tmp/skills-check.txt は `bunx skills check -g 2>&1 | tee /tmp/skills-check.txt` の結果。
 *
 * 使い方:
 *   bun check-vendor-updates.ts [--catalog-dir PATH]
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

function resolveCatalogRoot(): string {
  const argCatalog = process.argv.indexOf("--catalog-dir")
  if (argCatalog !== -1 && process.argv[argCatalog + 1]) {
    return path.resolve(process.argv[argCatalog + 1])
  }
  const env = process.env.MY_SKILLS_CATALOG_DIR
  if (env) return path.resolve(env.replace(/^~(?=$|\/)/, os.homedir()))
  return process.cwd()
}

/** ANSI escape code を除去して `✓ Updated <name>` 行からスキル名を抽出する。 */
function parseUpdatedSkills(checkFile: string): Set<string> {
  if (!fs.existsSync(checkFile)) return new Set()
  const clean = fs
    .readFileSync(checkFile, "utf-8")
    .replace(/\x1b\[[0-9;]*m/g, "")
  const updated = new Set<string>()
  for (const line of clean.split("\n")) {
    const m = line.match(/^\s*✓\s+Updated\s+([a-z][a-z0-9-]*)/)
    if (m) updated.add(m[1])
  }
  return updated
}

function ignoredSets(lock: Record<string, unknown>, catalogRoot: string): Set<string> {
  const lockIgnored = lock["ignored"] as unknown[] | undefined
  const fileIgnored = readJson(path.join(catalogRoot, ".skills-ignore.json"))?.ignore as unknown[] | undefined
  const toSet = (arr: unknown[] | undefined): Set<string> =>
    new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [])
  return new Set([...toSet(lockIgnored), ...toSet(fileIgnored)])
}

function main(): void {
  const catalogRoot = resolveCatalogRoot()
  const lock = readJson(path.join(catalogRoot, "skills.lock.json")) ?? {}

  const external = lock["external"] as Record<string, { source?: unknown }> | undefined
  const externalNames = external ? Object.keys(external) : []
  const ignored = ignoredSets(lock, catalogRoot)

  // --- Step 2: external スキル一覧 ---
  for (const name of externalNames.sort()) {
    process.stdout.write(`${name}\n`)
  }
  process.stdout.write("\n")

  // --- Step 4: /tmp/skills-check.txt とのクロスリファレンス ---
  const updated = parseUpdatedSkills("/tmp/skills-check.txt")
  const inLock = [...updated].filter((n) => externalNames.includes(n)).sort()
  const notInLock = [...updated].filter((n) => !externalNames.includes(n) && !ignored.has(n)).sort()

  process.stdout.write("📦 lock.json 管理かつ更新あり:\n")
  for (const s of inLock) {
    const ext = external?.[s]
    process.stdout.write(`  ✅ ${s}  (${ext?.source ?? ""})\n`)
  }

  if (notInLock.length > 0) {
    process.stdout.write("\n⚠️  更新ありだが lock.json 未管理:\n")
    for (const s of notInLock) {
      process.stdout.write(`  ⚠️  ${s}\n`)
    }
  }

  process.stdout.write(`\n→ lock.json external 全体: ${externalNames.length} 件\n`)
  process.stdout.write(`→ 更新あり (lock管理): ${inLock.length} 件\n`)
  process.stdout.write(`→ 更新あり (未管理): ${notInLock.length} 件\n\n`)

  // --- Step 5: 未管理スキルの棚卸し ---
  const custom = ((lock["custom"] as { skills?: Record<string, unknown> } | undefined)?.skills) ?? {}
  const vendor = (lock["vendor"] as Record<string, unknown> | undefined) ?? {}
  const managed = new Set([...externalNames, ...Object.keys(custom), ...Object.keys(vendor)])
  const installed = new Set<string>()
  const strAgentsDir = `${os.homedir()}/.agents/skills`
  if (fs.existsSync(strAgentsDir)) {
    for (const name of fs.readdirSync(strAgentsDir)) {
      if (name !== ".system") installed.add(name)
    }
  }
  const unmanaged = [...installed].filter((n) => !managed.has(n) && !ignored.has(n)).sort()

  const globalLockObj = readJson(`${os.homedir()}/.agents/.skill-lock.json`)
  const globalSkills = (globalLockObj?.skills as Record<string, { source?: unknown }> | undefined) ?? {}

  if (unmanaged.length > 0) {
    process.stdout.write("🔍 lock.json 未管理のインストール済みスキル:\n")
    for (const s of unmanaged) {
      const source = globalSkills[s]?.source ?? "unknown"
      process.stdout.write(`  ❓ ${s}  (${source})\n`)
    }
    process.stdout.write(`\n→ ${unmanaged.length} 件が未管理です。\n`)
    process.stdout.write("  /skills-add <owner/repo> で lock.json に追加するか\n")
    process.stdout.write("  .skills-ignore.json に追加して明示的に無視してください。\n")
  } else {
    process.stdout.write("✅ 未管理スキルはありません\n")
  }
}

if (import.meta.main) {
  main()
}