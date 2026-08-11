/**
 * lock-lookup CLI の照会契約テスト。
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SCRIPT = path.resolve(__dirname, "lock-lookup.ts")

function run(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", SCRIPT, ...args])
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

describe("lock-lookup", () => {
  test("external-source は lock.external[skill].source を返す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-lookup-"))
    const lockFile = path.join(dir, "skills.lock.json")
    fs.writeFileSync(lockFile, JSON.stringify({ external: { defuddle: { source: "kepano/obsidian-skills" } } }))
    const out = run("external-source", lockFile, "defuddle")
    expect(out.exitCode).toBe(0)
    expect(out.stdout.trim()).toBe("kepano/obsidian-skills")
  })

  test("external-source が無い skill は空行", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-lookup-miss-"))
    const lockFile = path.join(dir, "skills.lock.json")
    fs.writeFileSync(lockFile, JSON.stringify({ external: {} }))
    const out = run("external-source", lockFile, "missing")
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toBe("\n")
  })
})
