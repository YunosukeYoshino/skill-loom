/**
 * resolve-skill-path のパリティテスト。
 *
 * Python 版 resolve-skill-path.py の CLI 契約（env 入力・stdout・exit code）を
 * 保持していることを、Bun の test runner で検証する。gh API はテスト用の
 * stub に差し替え、期待値は既存の挙動から導出したリテラルを使う。
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SCRIPT = path.resolve(__dirname, "resolve-skill-path.ts")

function writeGhStub(dir: string, skillName: string, content: string): void {
  const encoded = Buffer.from(content, "utf-8").toString("base64")
  const stub = path.join(dir, "gh")
  fs.writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `encoded=${encoded}`,
      `skill_name=${skillName}`,
      'endpoint="${@: -1}"',
      "if [[ \"$endpoint\" == *\"/contents/packs/${skill_name}/SKILL.md\" ]]; then",
      '  echo "{\\\"content\\\": \\\"$encoded\\\"}"',
      "elif [[ \"$endpoint\" == *\"/contents/packs/other/SKILL.md\" ]]; then",
      '  echo "{\\\"content\\\": \\\"$encoded\\\"}"',
      "else",
      "  exit 1",
      "fi",
    ].join("\n"),
  )
  fs.chmodSync(stub, 0o755)
}

function runResolve(opts: {
  dir: string
  tree: unknown
  skillName: string
}): { exitCode: number; stdout: string; stderr: string } {
  const treeFile = path.join(opts.dir, "tree.json")
  fs.writeFileSync(treeFile, JSON.stringify(opts.tree))
  const result = Bun.spawnSync(
    ["bun", SCRIPT],
    {
      env: {
        ...process.env,
        TREE_FILE: treeFile,
        SKILL_NAME: opts.skillName,
        OWNER_REPO: "owner/repo",
        PATH: `${opts.dir}:${process.env.PATH ?? ""}`,
      },
    },
  )
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe("resolve-skill-path", () => {
  test("ツリー内の SKILL.md の name が一致すれば skillPath を stdout に出す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-"))
    writeGhStub(dir, "target", "---\nname: target\ndescription: fixture\n---\n")
    const out = runResolve({
      dir,
      tree: { tree: [{ path: "README.md", type: "blob" }, { path: "packs/target/SKILL.md", type: "blob" }] },
      skillName: "target",
    })
    expect(out.exitCode).toBe(0)
    expect(out.stdout.trim()).toBe("packs/target/SKILL.md")
  })

  test("一致する name がなければ空出力で exit 1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-miss-"))
    writeGhStub(dir, "other", "---\nname: other\ndescription: fixture\n---\n")
    const out = runResolve({ dir, tree: { tree: [{ path: "packs/other/SKILL.md", type: "blob" }] }, skillName: "missing" })
    expect(out.exitCode).not.toBe(0)
    expect(out.stdout).toBe("")
  })
})