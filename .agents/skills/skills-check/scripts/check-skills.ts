#!/usr/bin/env bun
/**
 * check-skills — skills.lock.json とインストール済みスキルの整合性を確認する（TypeScript 版）
 *
 * Python 版 check-skills.py を挙動互換で置き換える。CLI 契約（args・stdout・stderr・exit code）と
 * 公開関数（repo_defaults / classify / load_ignore / load_lock_ignored）の意味論は不変。
 *
 * 使い方:
 *   bun check-skills.ts [LOCK_FILE] [AGENTS_DIR] [CLAUDE_DIR] [IGNORE_FILE]
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

export interface RepoDefaults {
  lockFile: string
  agentsDir: string
  claudeDir: string
  ignoreFile: string
}

export interface ManagedEntry {
  kind: "custom" | "external" | "vendor"
  source: string
}

export interface SkillState {
  agents: boolean
  claude: boolean
}

export interface ExternalSkill extends SkillState {
  name: string
}

export interface ClassifyResult {
  custom: Record<string, SkillState>
  external: Record<string, ExternalSkill[]>
  ignored: Set<string>
  unmanagedAgents: Set<string>
  unmanagedClaude: Set<string>
}

export function findRepoRoot(start: string): string | null {
  let current = path.resolve(start)
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(current, "skills.lock.json"))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

export function repoDefaults(): RepoDefaults {
  let repoRoot: string
  const selectedCatalog = process.env.MY_SKILLS_CATALOG_DIR
  if (selectedCatalog) {
    repoRoot = path.resolve(selectedCatalog.replace(/^~(?=$|\/)/, os.homedir()))
  } else {
    const found = findRepoRoot(import.meta.dir)
    repoRoot = found ?? process.cwd()
  }
  const home = os.homedir()
  return {
    lockFile: path.join(repoRoot, "skills.lock.json"),
    agentsDir: path.join(home, ".agents", "skills"),
    claudeDir: path.join(home, ".claude", "skills"),
    ignoreFile: path.join(repoRoot, ".skills-ignore.json"),
  }
}

export function loadLock(lockFile: string): Record<string, unknown> {
  if (!fs.existsSync(lockFile)) {
    process.stderr.write(`Error: ${lockFile} not found\n`)
    process.exit(1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(lockFile, "utf-8"))
  } catch {
    process.stderr.write(`Error: Cannot parse lock file: ${lockFile}\n`)
    process.exit(1)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(`Error: Lock file is not a JSON object: ${lockFile}\n`)
    process.exit(1)
  }
  return parsed as Record<string, unknown>
}

export function loadIgnore(ignoreFile: string): Set<string> {
  if (!fs.existsSync(ignoreFile)) return new Set()
  const data = JSON.parse(fs.readFileSync(ignoreFile, "utf-8")) as { ignore?: unknown }
  const list = Array.isArray(data.ignore) ? data.ignore : []
  return new Set(list.filter((x): x is string => typeof x === "string"))
}

export function loadLockIgnored(lock: Record<string, unknown>): Set<string> {
  const ignored = lock["ignored"]
  const list = Array.isArray(ignored) ? ignored : []
  return new Set(list.filter((x): x is string => typeof x === "string"))
}

export function scanDir(directory: string, includeSymlinks = false): Set<string> {
  if (!fs.existsSync(directory)) return new Set()
  const names = new Set<string>()
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    if (entry.isDirectory() || (includeSymlinks && entry.isSymbolicLink())) {
      names.add(entry.name)
    }
  }
  return names
}

export function buildManagedSkills(lock: Record<string, unknown>): Record<string, ManagedEntry> {
  const managed: Record<string, ManagedEntry> = {}
  const custom = (lock["custom"] as { repo?: unknown; skills?: Record<string, unknown> } | undefined) ?? {}
  const external = (lock["external"] as Record<string, { source?: unknown }> | undefined) ?? {}
  const vendor = (lock["vendor"] as Record<string, unknown> | undefined) ?? {}
  const customRepo = typeof custom.repo === "string" ? custom.repo : "Catalog"

  for (const name of Object.keys(custom.skills ?? {})) {
    managed[name] = { kind: "custom", source: customRepo }
  }
  for (const [name, meta] of Object.entries(external)) {
    managed[name] = { kind: "external", source: typeof meta?.source === "string" ? meta.source : "unknown" }
  }
  for (const name of Object.keys(vendor)) {
    managed[name] = { kind: "vendor", source: customRepo }
  }
  return managed
}

export function classify(
  lock: Record<string, unknown>,
  ignoreList: Set<string>,
  agentsInstalled: Set<string>,
  claudeInstalled: Set<string>,
): ClassifyResult {
  const managed = buildManagedSkills(lock)
  const lockNames = new Set(Object.keys(managed))
  const allNames = new Set([...lockNames, ...agentsInstalled, ...claudeInstalled])
  const ignoredNames = new Set([...ignoreList, ...loadLockIgnored(lock)])

  const result: ClassifyResult = {
    custom: {},
    external: {},
    ignored: new Set(),
    unmanagedAgents: new Set(),
    unmanagedClaude: new Set(),
  }

  for (const name of [...allNames].sort()) {
    const inLock = Object.prototype.hasOwnProperty.call(managed, name)
    const inAgents = agentsInstalled.has(name)
    const inClaude = claudeInstalled.has(name)

    if (inLock) {
      const meta = managed[name]
      const state: SkillState = { agents: inAgents, claude: inClaude }
      if (meta.kind === "custom" || meta.kind === "vendor") {
        result.custom[name] = state
      } else {
        const list = result.external[meta.source] ?? []
        list.push({ name, ...state })
        result.external[meta.source] = list
      }
    } else if (ignoredNames.has(name)) {
      result.ignored.add(name)
    } else {
      if (inAgents) result.unmanagedAgents.add(name)
      if (inClaude) result.unmanagedClaude.add(name)
    }
  }

  return result
}

function printResults(result: ClassifyResult): void {
  const customTotal = Object.keys(result.custom).length
  const extTotal = Object.values(result.external).reduce((sum, list) => sum + list.length, 0)
  const unmanagedAll = new Set([...result.unmanagedAgents, ...result.unmanagedClaude])

  process.stdout.write("=== CUSTOM (Catalog) ===\n")
  let issuesCustom = 0
  for (const [name, state] of Object.entries(result.custom).sort(([a], [b]) => a.localeCompare(b))) {
    const markers: string[] = []
    if (!state.agents) markers.push("NO ~/.agents/skills/")
    if (!state.claude) markers.push("NO ~/.claude/skills/")
    const suffix = markers.length > 0 ? `  !! ${markers.join(", ")}` : ""
    process.stdout.write(`  ${name}${suffix}\n`)
    if (markers.length > 0) issuesCustom += 1
  }
  process.stdout.write(`  (${customTotal} skills, ${issuesCustom} issues)\n\n`)

  process.stdout.write("=== EXTERNAL (npx skills managed) ===\n")
  let issuesExt = 0
  for (const source of Object.keys(result.external).sort()) {
    const skills = result.external[source]
    process.stdout.write(`  ${source} (${skills.length})\n`)
    for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
      const markers: string[] = []
      if (!s.agents) markers.push("NO ~/.agents/skills/")
      if (!s.claude) markers.push("NO ~/.claude/skills/")
      const suffix = markers.length > 0 ? `  !! ${markers.join(", ")}` : ""
      process.stdout.write(`    ${s.name}${suffix}\n`)
      if (markers.length > 0) issuesExt += 1
    }
    process.stdout.write("\n")
  }
  process.stdout.write(`  (${extTotal} skills, ${issuesExt} issues)\n\n`)

  if (result.ignored.size > 0) {
    process.stdout.write(`=== IGNORED (plugin-managed, ${result.ignored.size}) ===\n`)
    for (const name of [...result.ignored].sort()) {
      process.stdout.write(`  ${name}\n`)
    }
    process.stdout.write("\n")
  }

  if (unmanagedAll.size > 0) {
    process.stdout.write(`=== UNMANAGED (${unmanagedAll.size}) ===\n`)
    for (const name of [...unmanagedAll].sort()) {
      const where: string[] = []
      if (result.unmanagedAgents.has(name)) where.push("~/.agents/skills/")
      if (result.unmanagedClaude.has(name)) where.push("~/.claude/skills/")
      process.stdout.write(`  ${name}  (${where.join(", ")})\n`)
    }
    process.stdout.write("\n")
  }

  process.stdout.write("=== TOTALS ===\n")
  process.stdout.write(`  Custom:    ${customTotal}\n`)
  process.stdout.write(`  External:  ${extTotal}\n`)
  process.stdout.write(`  Ignored:   ${result.ignored.size}\n`)
  process.stdout.write(`  Unmanaged: ${unmanagedAll.size}\n`)
  process.stdout.write(`  Issues:    ${issuesCustom + issuesExt}\n`)
  if (unmanagedAll.size === 0 && issuesCustom + issuesExt === 0) {
    process.stdout.write("  ALL CLEAN\n")
  }
  process.stdout.write("\n")
}

function main(): void {
  const defaults = repoDefaults()
  const lockFile = process.argv[2] ?? defaults.lockFile
  const agentsDir = process.argv[3] ?? defaults.agentsDir
  const claudeDir = process.argv[4] ?? defaults.claudeDir
  const ignoreFile = process.argv[5] ?? defaults.ignoreFile

  const lock = loadLock(lockFile)
  const ignoreList = new Set([...loadIgnore(ignoreFile), ...loadLockIgnored(lock)])
  const agentsInstalled = scanDir(agentsDir)
  const claudeInstalled = scanDir(claudeDir, true)

  const result = classify(lock, ignoreList, agentsInstalled, claudeInstalled)
  printResults(result)
}

if (import.meta.main) {
  main()
}