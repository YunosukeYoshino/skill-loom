/**
 * register-skill-lock のパリティテスト。
 *
 * Python 版 register-skill-lock.py の CLI 契約（args・JSON 変異・アトミック書き込み）を
 * 保持していることを、Bun の test runner で検証する。期待値は既存の挙動から
 * 導出したリテラルを使う。
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SCRIPT = path.resolve(__dirname, "register-skill-lock.ts")

function runRegister(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", SCRIPT, ...args])
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe("register-skill-lock", () => {
  test("既存セクションを保持しつつ external に項目を追加してアトミックに書き込む", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "register-"))
    const lockFile = path.join(dir, "skills.lock.json")
    fs.writeFileSync(
      lockFile,
      JSON.stringify(
        {
          version: 3,
          custom: { skills: { local: { repoPath: "skills/local" } } },
          external: { old: { source: "old/repo" } },
          vendor: { managed: { source: "upstream/repo" } },
        },
        null,
        2,
      ),
    )

    const out = runRegister([lockFile, "new", "owner/repo", "https://github.com/owner/repo.git", "packs/new/SKILL.md"])
    expect(out.exitCode).toBe(0)

    const lock = JSON.parse(fs.readFileSync(lockFile, "utf-8")) as Record<string, unknown>
    expect(lock["version"]).toBe(3)
    const custom = lock["custom"] as Record<string, unknown>
    expect(Object.keys((custom["skills"] as Record<string, unknown>) ?? {})).toContain("local")
    const external = lock["external"] as Record<string, unknown>
    expect(external["old"]).toEqual({ source: "old/repo" })
    expect(external["new"]).toEqual({
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "packs/new/SKILL.md",
    })
    const vendor = lock["vendor"] as Record<string, unknown>
    expect(vendor["managed"]).toEqual({ source: "upstream/repo" })

    expect(fs.existsSync(`${lockFile}.tmp`)).toBe(false)
  })

  test("external セクションが無い lock でも新規作成して登録する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "register-new-"))
    const lockFile = path.join(dir, "skills.lock.json")
    fs.writeFileSync(lockFile, JSON.stringify({ version: 3, custom: { skills: {} } }))

    const out = runRegister([lockFile, "alpha", "owner/repo", "https://github.com/owner/repo.git", "skills/alpha/SKILL.md"])
    expect(out.exitCode).toBe(0)

    const lock = JSON.parse(fs.readFileSync(lockFile, "utf-8")) as Record<string, unknown>
    const external = lock["external"] as Record<string, unknown>
    expect(external["alpha"]).toEqual({
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "skills/alpha/SKILL.md",
    })
  })

  test("external が配列の lock は schema error で exit 1 にする", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "register-arr-"))
    const lockFile = path.join(dir, "skills.lock.json")
    fs.writeFileSync(lockFile, JSON.stringify({ version: 3, external: [] }))

    const out = runRegister([lockFile, "alpha", "owner/repo", "https://github.com/owner/repo.git", "skills/alpha/SKILL.md"])
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain("external section must be an object")

    const lock = JSON.parse(fs.readFileSync(lockFile, "utf-8")) as Record<string, unknown>
    expect(lock["external"]).toEqual([])
  })

  test("並行する2件の登録が両方保存される", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "register-conc-"))
    const lockFile = path.join(dir, "skills.lock.json")
    fs.writeFileSync(lockFile, JSON.stringify({ version: 3, custom: { skills: {} }, external: {} }, null, 2))

    const makers = ["alpha", "beta"].map((name) =>
      Bun.spawn(["bun", SCRIPT, lockFile, name, "owner/repo", "https://github.com/owner/repo.git", `skills/${name}/SKILL.md`], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const codes = await Promise.all(makers.map((proc) => proc.exited))
    expect(codes).toEqual([0, 0])

    const lock = JSON.parse(fs.readFileSync(lockFile, "utf-8")) as { external: Record<string, unknown> }
    expect(lock.external["alpha"]).toEqual({
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "skills/alpha/SKILL.md",
    })
    expect(lock.external["beta"]).toEqual({
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "skills/beta/SKILL.md",
    })
  })
})
