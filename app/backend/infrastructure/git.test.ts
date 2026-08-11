import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitRepoChanges, repoRelativePaths } from "./git"

let sandbox: string
let catalog: string
const touched: string[] = []

function setEnv(name: string, value: string): void {
  touched.push(name)
  process.env[name] = value
}

function git(args: string[], cwd = catalog): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-git-"))
  catalog = join(sandbox, "catalog")
  mkdirSync(catalog, { recursive: true })
  setEnv("MY_SKILLS_CATALOG_DIR", catalog)

  expect(git(["init"]).code).toBe(0)
  expect(git(["config", "user.name", "Skill Loom Test"]).code).toBe(0)
  expect(git(["config", "user.email", "skill-loom@example.invalid"]).code).toBe(0)
})

afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name]
  rmSync(sandbox, { recursive: true, force: true })
})

describe("repoRelativePaths", () => {
  test("paths are relative to the selected Catalog Root", () => {
    expect(repoRelativePaths([join(catalog, "skills.lock.json")])).toEqual(["skills.lock.json"])
  })

  test("paths outside the selected Catalog Root are rejected", () => {
    expect(repoRelativePaths([join(sandbox, "outside.json")])).toEqual([])
  })
})

describe("commitRepoChanges", () => {
  test("automatic commits are created in the selected Catalog repository", () => {
    const lockPath = join(catalog, "skills.lock.json")
    writeFileSync(lockPath, "{}\n")

    expect(commitRepoChanges("test: update catalog lock", [lockPath])).toBe(" / git commit 済み")

    expect(git(["log", "--oneline", "--", "skills.lock.json"]).stdout).toContain("test: update catalog lock")
    expect(git(["status", "--short"]).stdout).toBe("")
  })
})
