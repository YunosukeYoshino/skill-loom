#!/usr/bin/env bun
/**
 * register-unmanaged — Register unmanaged skills into skills.lock.json（TypeScript 版）
 *
 * Python 版 register_unmanaged.py を挙動互換で置き換える。CLI 契約（args・stdout・stderr・
 * exit code・JSON 変異）と公開関数（is_custom_skill / build_custom_entry / get_repo_root）の
 * 意味論は不変。
 *
 * 使い方:
 *   bun register_unmanaged.ts [--dry-run] [--skills a,b] [--mode auto|custom|external]
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { updateInventoryLock } from "../../skills-add/scripts/update-inventory-lock"

const CATALOG_ROOT_ENV = "MY_SKILLS_CATALOG_DIR"
const REPO_ROOT_ENV = "REPO_ROOT"
const GLOBAL_LOCK_PATH = path.join(os.homedir(), ".agents", ".skill-lock.json")
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".agents", "skills")
const LOCAL_SKILLS_DIR_STR = ".agents/skills"

// Known category mapping for common skill names
const CATEGORY_HINTS: Record<string, string> = {
  "technical-research": "research",
  "api-and-interface-design": "engineering",
  "software-engineering-principles": "engineering",
  "context-engineering": "engineering",
  "source-driven-development": "engineering",
  "tdd-twada": "engineering",
  "vercel-react-best-practices": "engineering",
  hono: "engineering",
  "prisma-cli": "engineering",
  "prisma-client-api": "engineering",
  "prisma-database-setup": "engineering",
  "prisma-driver-adapter-implementation": "engineering",
  "prisma-postgres": "engineering",
  "postgres-best-practices": "engineering",
  "react-router-framework-mode": "engineering",
  "turso-db": "engineering",
  "frontend-ui-engineering": "design",
  "high-end-visual-design": "design",
  "minimalist-ui": "design",
  "baseline-ui": "design",
  shadcn: "design",
  "make-interfaces-feel-better": "design",
  "ui-ux-pro-max": "design",
  "web-design-guidelines": "design",
  "security-and-hardening": "engineering",
  "fixing-accessibility": "design",
  "fixing-metadata": "design",
  "fixing-motion-performance": "engineering",
  "performance-optimization": "engineering",
  "gemini-search": "research",
  "use-tinyfish": "research",
  "idea-refine": "research",
  git: "workflow",
  "new-skill": "workflow",
  "update-skill": "workflow",
  "vendor-fork": "workflow",
  "skills-add": "workflow",
  "symphony-setup": "workflow",
  "symphony-spec-writer": "workflow",
  "symphony-delivery-flow": "workflow",
  "check-vendor-updates": "workflow",
  "wp-env-cli": "devops",
  portless: "devops",
  "bitwarden-dev-secrets": "devops",
  "docker-cleanup": "devops",
  "obsidian-markdown": "external-tools",
  "openai-docs": "external-tools",
  "browser-use": "external-tools",
  "agent-browser": "external-tools",
  notion: "external-tools",
  electron: "external-tools",
  copywriting: "marketing",
  "lead-magnets": "marketing",
  "marketing-psychology": "marketing",
  "programmatic-seo": "marketing",
  "sales-enablement": "marketing",
  revops: "marketing",
  "page-cro": "marketing",
  "site-architecture": "marketing",
}

type JsonData = Record<string, unknown> | unknown[] | null

function loadJson(filePath: string): JsonData {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as JsonData
  } catch {
    return null
  }
}

export function getRepoRoot(): string {
  const env = process.env[CATALOG_ROOT_ENV] || process.env[REPO_ROOT_ENV]
  if (env) return path.resolve(env.replace(/^~(?=$|\/)/, os.homedir()))
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"])
  const repoRoot = result.stdout.toString().trim()
  if (result.exitCode !== 0 || repoRoot === "") {
    throw new Error("Cannot determine repository root")
  }
  return repoRoot
}

function getManagedSets(lock: Record<string, unknown>): { external: Set<string>; custom: Set<string>; vendor: Set<string>; lockIgnored: Set<string> } {
  const external = lock["external"] as Record<string, unknown> | undefined
  const custom = (lock["custom"] as { skills?: Record<string, unknown> } | undefined)?.skills ?? {}
  const vendor = lock["vendor"] as Record<string, unknown> | undefined
  const lockIgnored = lock["ignored"]
  const toSet = (obj: Record<string, unknown> | undefined): Set<string> => new Set(obj ? Object.keys(obj) : [])
  const arrToSet = (arr: unknown): Set<string> => (Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set())
  return {
    external: toSet(external),
    custom: toSet(custom),
    vendor: toSet(vendor),
    lockIgnored: arrToSet(lockIgnored),
  }
}

function getFileIgnored(repoRoot: string): Set<string> {
  const ignorePath = path.join(repoRoot, ".skills-ignore.json")
  const data = loadJson(ignorePath)
  if (data && !Array.isArray(data) && Array.isArray((data as Record<string, unknown>).ignore)) {
    return new Set(((data as Record<string, unknown>).ignore as unknown[]).filter((x): x is string => typeof x === "string"))
  }
  return new Set()
}

function getInstalledSkills(): Set<string> {
  if (!fs.existsSync(GLOBAL_SKILLS_DIR)) return new Set()
  const names = new Set<string>()
  for (const entry of fs.readdirSync(GLOBAL_SKILLS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== ".system") names.add(entry.name)
  }
  return names
}

function getLocalSkillDirs(repoRoot: string): Set<string> {
  const localDir = path.join(repoRoot, LOCAL_SKILLS_DIR_STR)
  if (!fs.existsSync(localDir)) return new Set()
  const names = new Set<string>()
  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    if (entry.isDirectory()) names.add(entry.name)
  }
  return names
}

function getGlobalLockSkills(): Record<string, Record<string, unknown>> {
  const data = loadJson(GLOBAL_LOCK_PATH)
  if (data && !Array.isArray(data) && typeof (data as Record<string, unknown>).skills === "object") {
    return (data as Record<string, unknown>).skills as Record<string, Record<string, unknown>>
  }
  return {}
}

export function isCustomSkill(skillName: string, repoRoot: string, globalLock: Record<string, Record<string, unknown>>, customRepo: string): boolean {
  const localSkillDir = path.join(repoRoot, LOCAL_SKILLS_DIR_STR, skillName)
  if (fs.existsSync(localSkillDir) && fs.statSync(localSkillDir).isDirectory()) return true

  const source = (globalLock[skillName]?.source as string | undefined) ?? ""
  if (customRepo && source === customRepo) return true

  return false
}

function inferCategory(skillName: string): string {
  return CATEGORY_HINTS[skillName] ?? "engineering"
}

function inferRepoPath(skillName: string, category: string): string {
  return `skills/${category}/${skillName}`
}

export function buildCustomEntry(skillName: string, repoRoot: string, _globalLock: Record<string, Record<string, unknown>>): { repoPath: string; category: string } | null {
  const category = inferCategory(skillName)
  const repoPath = inferRepoPath(skillName, category)

  const actualPath = path.join(repoRoot, repoPath, "SKILL.md")
  if (fs.existsSync(actualPath)) return { repoPath, category }

  const altPath = path.join(repoRoot, LOCAL_SKILLS_DIR_STR, skillName)
  if (fs.existsSync(altPath) && fs.statSync(altPath).isDirectory() && fs.existsSync(path.join(altPath, "SKILL.md"))) {
    return { repoPath: `${LOCAL_SKILLS_DIR_STR}/${skillName}`, category }
  }

  return null
}

function buildExternalEntry(skillName: string, globalLock: Record<string, Record<string, unknown>>): Record<string, unknown> | null {
  const info = globalLock[skillName]
  if (!info) return null

  const entry: Record<string, unknown> = {}
  for (const key of ["source", "sourceUrl", "skillPath"]) {
    if (info[key] !== undefined) entry[key] = info[key]
  }
  for (const key of ["localRepoPath", "category"]) {
    if (info[key] !== undefined) entry[key] = info[key]
  }
  if (entry["source"] === undefined || entry["skillPath"] === undefined) return null
  return entry
}

type Entry = Record<string, unknown>

function registerSkills(lock: Record<string, unknown>, skillsToRegister: Record<string, Entry>, mode: "custom" | "external"): { added: { name: string; entry: Entry }[]; skipped: { name: string; reason: string }[] } {
  const mutations: { added: { name: string; entry: Entry }[]; skipped: { name: string; reason: string }[] } = { added: [], skipped: [] }

  const custom = (lock["custom"] as Record<string, unknown> | undefined) ?? {}
  const customSkills = (custom["skills"] as Record<string, unknown> | undefined) ?? {}
  const external = (lock["external"] as Record<string, unknown> | undefined) ?? {}

  let section: Record<string, Entry>
  if (mode === "custom") {
    lock["custom"] = custom
    custom["skills"] = customSkills
    section = customSkills as Record<string, Entry>
  } else {
    lock["external"] = external
    section = external as Record<string, Entry>
  }

  for (const [name, entry] of Object.entries(skillsToRegister)) {
    if (name in section) {
      mutations.skipped.push({ name, reason: "already_registered" })
      continue
    }
    section[name] = entry
    mutations.added.push({ name, entry })
  }

  if (mode === "external") {
    lock["external"] = sortObject(external)
  } else {
    custom["skills"] = sortObject(customSkills)
  }

  return mutations
}

function sortObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key]
  }
  return sorted
}

type CliArgs = { dryRun: boolean; skills: string | null; mode: "auto" | "custom" | "external" }

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, skills: null, mode: "auto" }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--skills" && i + 1 < argv.length) args.skills = argv[++i]
    else if (arg === "--mode" && i + 1 < argv.length) {
      const mode = argv[++i]
      if (mode === "auto" || mode === "custom" || mode === "external") args.mode = mode
    }
  }
  return args
}

export function main(argv: string[]): void {
  const args = parseArgs(argv)

  const repoRoot = getRepoRoot()
  const lockPath = path.join(repoRoot, "skills.lock.json")
  const lockData = loadJson(lockPath)
  if (lockData === null || Array.isArray(lockData)) {
    process.stderr.write(`Error: ${lockPath} not found or invalid\n`)
    process.exit(1)
  }
  const lock = lockData as Record<string, unknown>

  const { external, custom, vendor, lockIgnored } = getManagedSets(lock)
  const customRepo = ((lock["custom"] as { repo?: string } | undefined)?.repo ?? "") as string
  const fileIgnored = getFileIgnored(repoRoot)
  const ignored = new Set([...lockIgnored, ...fileIgnored])
  const managed = new Set([...external, ...custom, ...vendor])

  const installed = getInstalledSkills()
  let unmanaged = new Set([...installed].filter((n) => !managed.has(n) && !ignored.has(n)))

  if (args.skills) {
    const targetSkills = new Set(args.skills.split(","))
    unmanaged = new Set([...unmanaged].filter((n) => targetSkills.has(n)))
    if (unmanaged.size !== targetSkills.size) {
      const notFound = new Set([...targetSkills].filter((n) => !unmanaged.has(n)))
      const alreadyManaged = new Set([...targetSkills].filter((n) => managed.has(n)))
      if (alreadyManaged.size > 0) {
        process.stdout.write(`⚠️  Already managed (skipped): ${[...alreadyManaged].sort().join(", ")}\n`)
      }
      const notExisting = new Set([...notFound].filter((n) => !alreadyManaged.has(n)))
      if (notExisting.size > 0) {
        process.stdout.write(`⚠️  Not found in installed skills: ${[...notExisting].sort().join(", ")}\n`)
      }
    }
  }

  if (unmanaged.size === 0) {
    process.stdout.write("✅ No unmanaged skills to register\n")
    return
  }

  const globalLock = getGlobalLockSkills()
  getLocalSkillDirs(repoRoot)

  const customSkills: Record<string, Entry> = {}
  const externalSkills: Record<string, Entry> = {}

  for (const name of [...unmanaged].sort()) {
    let isCustom: boolean
    if (args.mode === "custom") isCustom = true
    else if (args.mode === "external") isCustom = false
    else isCustom = isCustomSkill(name, repoRoot, globalLock, customRepo)

    if (isCustom) {
      const entry = buildCustomEntry(name, repoRoot, globalLock)
      if (entry === null) {
        process.stdout.write(`⚠️  Cannot locate repo source for custom skill '${name}' — skipping\n`)
        continue
      }
      customSkills[name] = entry
    } else {
      const entry = buildExternalEntry(name, globalLock)
      if (entry === null) {
        process.stdout.write(`⚠️  Cannot determine source for '${name}' — skipping\n`)
        process.stdout.write("   Register manually: /skills-add <owner/repo>\n")
        continue
      }
      externalSkills[name] = entry
    }
  }

  process.stdout.write(`\n📋 Registration plan (${args.dryRun ? "dry run" : "live"}):\n`)
  if (Object.keys(customSkills).length > 0) {
    process.stdout.write(`\n🏠 → custom.skills (${Object.keys(customSkills).length} 件):\n`)
    for (const [name, entry] of Object.entries(customSkills)) {
      process.stdout.write(`  + ${name}: ${JSON.stringify(entry)}\n`)
    }
  }
  if (Object.keys(externalSkills).length > 0) {
    process.stdout.write(`\n📦 → external (${Object.keys(externalSkills).length} 件):\n`)
    for (const [name, entry] of Object.entries(externalSkills)) {
      process.stdout.write(`  + ${name}: ${(entry["source"] as string) ?? "?"}\n`)
    }
  }

  if (args.dryRun) {
    process.stdout.write("\n🔒 Dry run — no changes written\n")
    return
  }

  const results: Record<string, { added: unknown[]; skipped: unknown[] }> = {}
  updateInventoryLock(lockPath, (freshLock) => {
    if (Object.keys(customSkills).length > 0) {
      results["custom"] = registerSkills(freshLock, customSkills, "custom")
    }
    if (Object.keys(externalSkills).length > 0) {
      results["external"] = registerSkills(freshLock, externalSkills, "external")
    }
  })
  process.stdout.write(`\n✅ Updated ${lockPath}\n`)

  for (const [mode, result] of Object.entries(results)) {
    process.stdout.write(`  ${mode}: ${result.added.length} added, ${result.skipped.length} skipped\n`)
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Error: ${message}\n`)
    process.exit(1)
  }
}