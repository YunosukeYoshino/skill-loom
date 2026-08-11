/**
 * skills-restore ユーティリティ（lock-repo / restore-lock）のパリティテスト。
 *
 * Python 版 lock-repo.py / restore-lock.py の CLI 契約（stdout・stderr・exit code）を
 * 保持していることを、Bun の test runner で検証する。期待値は既存の挙動から
 * 導出したリテラルを使う。
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const LOCK_REPO = path.resolve(__dirname, "lock-repo.ts")
const RESTORE_LOCK = path.resolve(__dirname, "restore-lock.ts")

function run(script: string, ...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", script, ...args])
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe("lock-repo", () => {
  test("lock の custom.repo を stdout に出す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockrepo-"))
    const lockFile = path.join(dir, "skills.lock.json")
    fs.writeFileSync(lockFile, JSON.stringify({ version: 1, custom: { repo: "owner/catalog", skills: {} } }))

    const out = run(LOCK_REPO, lockFile)
    expect(out.exitCode).toBe(0)
    expect(out.stdout.trim()).toBe("owner/catalog")
  })
})

describe("restore-lock", () => {
  test("installSkill を npx filter に使う", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restorel-"))
    const lockFile = path.join(dir, "skills.lock.json")
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        external: {
          "json-render": { source: "vercel-labs/json-render", installSkill: "react" },
          defuddle: { source: "kepano/obsidian-skills" },
        },
      }),
    )

    const out = run(RESTORE_LOCK, lockFile)
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain(
      "npx skills add vercel-labs/json-render --skill react -g -a claude-code -a codex -a antigravity -y",
    )
    expect(out.stdout).toContain(
      "npx skills add kepano/obsidian-skills --skill defuddle -g -a claude-code -a codex -a antigravity -y",
    )
    expect(out.stdout).not.toContain("--skill json-render")
  })

  test("source が無い external をスキップして warning を stderr に出す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restoremiss-"))
    const lockFile = path.join(dir, "skills.lock.json")
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ external: { broken: {}, defuddle: { source: "kepano/obsidian-skills" } } }),
    )

    const out = run(RESTORE_LOCK, lockFile)
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain("npx skills add kepano/obsidian-skills")
    expect(out.stdout).not.toContain("--skill broken")
    expect(out.stderr).toContain("missing source")
  })
})