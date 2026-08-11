/**
 * Projection 書き込みのテスト。移行全体で最も危険な経路なので、ADR 0006 が言う
 * 「4 か所」— Active / Archive / CLI lock / エージェント symlink 2 種 — が
 * 実際に揃って書き換わることを、1 つずつ目で見て確かめる。
 *
 * サンドボックスは `MY_SKILLS_*` で丸ごと差し替える。ここが効いていないと、
 * このテスト自身が開発者の `~/.agents` と `~/.claude` を消しにいく。
 * 差し替えの検証は config.test.ts が受け持っている。
 *
 * 削除は `MY_SKILLS_TRASH_BIN` の adapter を呼ぶ。実装は production と同じ
 * trash 経路を通しつつ、テストでは一時ディレクトリだけを確実に消す。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ValueError } from "./errors"
import type { Lock } from "./inventory"
import {
  applyDeck,
  applyProjectionPlan,
  applyPresetTarget,
  bulkOffActive,
  deregisterFromCliLock,
  installCommands,
  installCustomFromRepo,
  installProjectDeck,
  planProjection,
  restorePreviousPreset,
} from "./projection"

let sandbox: string
const touched: string[] = []

const lock: Lock = {
  custom: { repo: "owner/catalog", skills: { alpha: { repoPath: "skills/a/alpha" }, beta: { repoPath: "skills/b/beta" } } },
  external: { ext: { source: "owner/repo" } },
}

function setEnv(name: string, value: string): void {
  touched.push(name)
  process.env[name] = value
}

const dir = (...parts: string[]) => join(sandbox, ...parts)

/** active / archive に実体を置き、エージェント側にも symlink を張った状態を作る。 */
function install(where: "active" | "archive", ...names: string[]): void {
  for (const name of names) {
    mkdirSync(dir(where, name), { recursive: true })
    writeFileSync(dir(where, name, "SKILL.md"), `---\nname: ${name}\n---\n`)
    if (where !== "active") continue
    for (const agent of ["claude-skills", "gemini-skills"]) {
      mkdirSync(dir(agent), { recursive: true })
      symlinkSync(dir("active", name), dir(agent, name))
    }
  }
}

function linked(name: string): boolean {
  return ["claude-skills", "gemini-skills"].some((agent) => {
    try {
      return lstatSync(dir(agent, name)).isSymbolicLink()
    } catch {
      return false
    }
  })
}

function writeCliLock(skills: Record<string, unknown>): void {
  writeFileSync(dir("cli-lock.json"), JSON.stringify({ version: 1, skills }, null, 2))
}

function readCliLock(): { version?: number; skills: Record<string, unknown> } {
  return JSON.parse(readFileSync(dir("cli-lock.json"), "utf8"))
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-projection-"))
  for (const sub of ["active", "archive", "claude-skills", "gemini-skills", "presets"]) {
    mkdirSync(join(sandbox, sub), { recursive: true })
  }
  setEnv("MY_SKILLS_ACTIVE_DIR", dir("active"))
  setEnv("MY_SKILLS_ARCHIVE_DIR", dir("archive"))
  setEnv("MY_SKILLS_CLAUDE_SKILLS_DIR", dir("claude-skills"))
  setEnv("MY_SKILLS_GEMINI_SKILLS_DIR", dir("gemini-skills"))
  setEnv("MY_SKILLS_GLOBAL_LOCK_FILE", dir("cli-lock.json"))
  setEnv("MY_SKILLS_PRESETS_DIR", dir("presets"))
  setEnv("MY_SKILLS_IGNORE_FILE", dir("ignore.json"))
  writeFileSync(
    dir("trash-stub"),
    "#!/usr/bin/env bash\nset -euo pipefail\nfor path in \"$@\"; do mv -- \"$path\" \"$path.trashed\"; done\n",
  )
  chmodSync(dir("trash-stub"), 0o755)
  setEnv("MY_SKILLS_TRASH_BIN", dir("trash-stub"))
})

afterEach(() => {
  for (const name of touched) delete process.env[name]
  touched.length = 0
  rmSync(sandbox, { recursive: true, force: true })
})

describe("Projection plan", () => {
  test("active target から preview 用の plan を作る", () => {
    install("active", "alpha")
    install("archive", "beta")

    const plan = planProjection({ target: new Set(["alpha"]), touchArchive: true }, lock)

    expect([...plan.remove]).toEqual(["beta"])
    expect([...plan.restore]).toEqual([])
    expect([...plan.install]).toEqual([])
    expect([...plan.unresolved]).toEqual([])
  })

  test("unresolved を含む plan は Projection を書き換えない", () => {
    install("active", "alpha")

    const plan = planProjection({ target: new Set(["nobody"]) }, lock)
    const outcome = applyProjectionPlan(plan, lock)

    expect(outcome.applied).toBe(false)
    expect([...outcome.unresolved]).toEqual(["nobody"])
    expect(outcome.installFailure).toBeNull()
    expect(existsSync(dir("active", "alpha"))).toBe(true)
  })

  test("preview と同じ plan を apply できる", () => {
    install("active", "alpha")

    const plan = planProjection({ target: new Set(["alpha"]) }, lock)
    const outcome = applyProjectionPlan(plan, lock)

    expect(outcome.applied).toBe(true)
    expect([...outcome.changed]).toEqual([])
    expect(outcome.unresolved).toEqual(new Set())
    expect(outcome.warning).toBeNull()
    expect(outcome.installFailure).toBeNull()
  })

  test("install adapter の失敗を outcome に残す", () => {
    const installLock: Lock = { custom: { skills: { missing: { repoPath: "missing-projection-source" } } } }
    const plan = planProjection({ target: new Set(["missing"]) }, installLock)
    const outcome = applyProjectionPlan(plan, installLock)

    expect(outcome.applied).toBe(false)
    expect(outcome.installFailure?.kind).toBe("install")
    expect(outcome.installFailure?.detail).toContain("custom skill source not found")
  })
})

describe("Off にすると 4 か所すべてから消える", () => {
  test("Active・symlink 2 種・CLI lock が揃って落ちる", () => {
    install("active", "alpha")
    writeCliLock({ alpha: { source: "owner/repo" }, keepme: { source: "other/repo" } })

    const warning = applyDeck(new Set(), new Set(), new Set(), lock, new Set(["alpha"]))

    expect(warning).toBe("")
    expect(existsSync(dir("active", "alpha"))).toBe(false)
    expect(linked("alpha")).toBe(false)
    // CLI lock は read-modify-write。他のエントリを巻き添えにしない。
    expect(Object.keys(readCliLock().skills)).toEqual(["keepme"])
  })

  test("archive 側にある skill も実体ごと落ちる", () => {
    install("archive", "alpha")

    applyDeck(new Set(), new Set(), new Set(), lock, new Set(["alpha"]))

    expect(existsSync(dir("archive", "alpha"))).toBe(false)
  })
})

describe("Archive は実体を残す", () => {
  test("Active から Archive へ移り、symlink だけ外れる", () => {
    install("active", "alpha")
    writeCliLock({ alpha: { source: "owner/repo" } })

    applyDeck(new Set(["alpha"]), new Set(), new Set(), lock, new Set())

    expect(existsSync(dir("active", "alpha"))).toBe(false)
    expect(existsSync(dir("archive", "alpha", "SKILL.md"))).toBe(true)
    expect(linked("alpha")).toBe(false)
    // Archive も projection から抜けることなので CLI lock からは外す。
    expect(Object.keys(readCliLock().skills)).toEqual([])
  })

  test("Archive に同名が既にあれば Active 側を捨てる", () => {
    install("active", "alpha")
    install("archive", "alpha")

    applyDeck(new Set(["alpha"]), new Set(), new Set(), lock, new Set())

    expect(existsSync(dir("active", "alpha"))).toBe(false)
    expect(existsSync(dir("archive", "alpha"))).toBe(true)
  })
})

describe("Restore は Archive から戻して symlink を張り直す", () => {
  test("実体が Active へ戻り、両エージェントから相対 symlink で見える", () => {
    install("archive", "alpha")

    applyDeck(new Set(), new Set(["alpha"]), new Set(), lock, new Set())

    expect(existsSync(dir("active", "alpha", "SKILL.md"))).toBe(true)
    expect(existsSync(dir("archive", "alpha"))).toBe(false)
    for (const agent of ["claude-skills", "gemini-skills"]) {
      const link = dir(agent, "alpha")
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      // 絶対パスで張ると home を移したときに全部壊れる。
      expect(readlinkSync(link).startsWith("/")).toBe(false)
      expect(resolve(dir(agent), readlinkSync(link))).toBe(dir("active", "alpha"))
    }
  })

  test("Active に同名があれば Archive 側はそのまま残す", () => {
    install("active", "alpha")
    install("archive", "alpha")

    applyDeck(new Set(), new Set(["alpha"]), new Set(), lock, new Set())

    expect(existsSync(dir("active", "alpha"))).toBe(true)
    expect(existsSync(dir("archive", "alpha"))).toBe(true)
  })
})

describe("deregisterFromCliLock", () => {
  test("CLI lock が無ければ警告なし", () => {
    expect(deregisterFromCliLock(new Set(["alpha"]))).toBe("")
  })

  test("読めない形式なら警告を返し、処理は続行できる", () => {
    writeFileSync(dir("cli-lock.json"), "{ not json")
    expect(deregisterFromCliLock(new Set(["alpha"]))).toContain("読めない形式")
  })

  test("想定外の構造なら警告を返す", () => {
    writeFileSync(dir("cli-lock.json"), JSON.stringify({ skills: [] }))
    expect(deregisterFromCliLock(new Set(["alpha"]))).toContain("想定外の構造")
  })

  test("載っていない名前だけなら書き換えない", () => {
    writeCliLock({ keepme: {} })
    const before = readFileSync(dir("cli-lock.json"), "utf8")

    expect(deregisterFromCliLock(new Set(["alpha"]))).toBe("")
    expect(readFileSync(dir("cli-lock.json"), "utf8")).toBe(before)
  })

  test("skills 以外のキーを保つ", () => {
    writeCliLock({ alpha: {} })
    deregisterFromCliLock(new Set(["alpha"]))
    expect(readCliLock().version).toBe(1)
  })
})

describe("bulkOffActive", () => {
  test("管理下の active だけを落とし、直前の状態を _last に残す", () => {
    install("active", "alpha", "ghost")
    install("archive", "beta")

    const removed = bulkOffActive(lock, true)

    // ghost は lock に載っていないので触らない。archive も対象外。
    expect([...removed].sort()).toEqual(["alpha"])
    expect(existsSync(dir("active", "ghost"))).toBe(true)
    expect(existsSync(dir("archive", "beta"))).toBe(true)
    expect(existsSync(dir("active", "alpha"))).toBe(false)

    const last = JSON.parse(readFileSync(dir("presets", "_last.json"), "utf8"))
    expect(last.skills).toEqual(["alpha"])
    expect(last.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })

  test("管理下の active が無ければ ValueError（呼び出し側が 400 にする）", () => {
    install("active", "ghost")
    expect(() => bulkOffActive(lock, true)).toThrow(ValueError)
  })
})

describe("applyPresetTarget / restorePreviousPreset", () => {
  test("当てた集合以外は off になり、直前の状態が _last に残る", () => {
    install("active", "alpha", "beta")

    applyPresetTarget(new Set(["alpha"]), lock)

    expect(existsSync(dir("active", "alpha"))).toBe(true)
    expect(existsSync(dir("active", "beta"))).toBe(false)
    // off は archive 行きではない。archive に落としていたら「消したはずのものが残る」。
    expect(existsSync(dir("archive", "beta"))).toBe(false)
    expect(linked("beta")).toBe(false)

    expect(JSON.parse(readFileSync(dir("presets", "_last.json"), "utf8")).skills).toEqual(["alpha", "beta"])
  })

  test("unresolved があれば 1 バイトも書かずに投げる", () => {
    install("active", "alpha")

    expect(() => applyPresetTarget(new Set(["nobody"]), lock)).toThrow("Unresolved: nobody")
    expect(existsSync(dir("active", "alpha"))).toBe(true)
    expect(existsSync(dir("presets", "_last.json"))).toBe(false)
  })

  test("Restore は archive と未追跡の active を巻き添えにしない", () => {
    install("active", "alpha", "ghost")
    install("archive", "beta")
    writeFileSync(
      dir("presets", "_last.json"),
      JSON.stringify({ name: "_last", skills: ["alpha", "beta"], updatedAt: "2026-01-01T00:00:00+09:00" }),
    )

    const plan = restorePreviousPreset(lock)

    expect(existsSync(dir("active", "alpha"))).toBe(true)
    // archive にあった beta は active へ戻る。
    expect(existsSync(dir("active", "beta"))).toBe(true)
    expect(linked("beta")).toBe(true)
    // lock に載っていない ghost は Restore の対象外なので残す。
    expect(existsSync(dir("active", "ghost"))).toBe(true)
    expect([...plan.unresolved]).toEqual([])
  })

  test("Restore は戻す前の active を _last に入れ直す（もう一度押すと元に戻る）", () => {
    install("active", "alpha")
    writeFileSync(
      dir("presets", "_last.json"),
      JSON.stringify({ name: "_last", skills: [], updatedAt: "2026-01-01T00:00:00+09:00" }),
    )

    restorePreviousPreset(lock)

    expect(existsSync(dir("active", "alpha"))).toBe(false)
    expect(JSON.parse(readFileSync(dir("presets", "_last.json"), "utf8")).skills).toEqual(["alpha"])
  })

  test("Restore は解決できない skill を飛ばして残りを戻す", () => {
    install("archive", "alpha")
    writeFileSync(
      dir("presets", "_last.json"),
      JSON.stringify({ name: "_last", skills: ["alpha", "nobody"], updatedAt: "2026-01-01T00:00:00+09:00" }),
    )

    const plan = restorePreviousPreset(lock)

    expect([...plan.unresolved]).toEqual(["nobody"])
    expect(existsSync(dir("active", "alpha"))).toBe(true)
  })

  test("_last が無ければ ValueError", () => {
    expect(() => restorePreviousPreset(lock)).toThrow("No previous state saved")
  })
})

describe("installCommands", () => {
  test("同じ source の skill は 1 コマンドにまとまる", () => {
    const many: Lock = { external: { a: { source: "o/r" }, b: { source: "o/r" }, c: { source: "z/other" } } }

    expect(installCommands(new Set(["a", "b", "c"]), many)).toEqual([
      ["bunx", "skills", "add", "o/r", "--skill", "a", "--skill", "b", "-g", "-a", "claude-code", "-a", "codex", "-a", "antigravity", "-y"],
      ["bunx", "skills", "add", "z/other", "--skill", "c", "-g", "-a", "claude-code", "-a", "codex", "-a", "antigravity", "-y"],
    ])
  })

  test("external に載っていない名前は無視する", () => {
    expect(installCommands(new Set(["alpha"]), lock)).toEqual([])
  })
})

describe("installCustomFromRepo", () => {
  test("Custom Skill source is copied from the selected Catalog Root", () => {
    const catalog = dir("catalog")
    setEnv("MY_SKILLS_CATALOG_DIR", catalog)
    mkdirSync(dir("catalog", "skills", "engineering", "gamma"), { recursive: true })
    writeFileSync(
      dir("catalog", "skills", "engineering", "gamma", "SKILL.md"),
      "---\nname: gamma\ndescription: Catalog source\n---\n",
    )

    installCustomFromRepo(
      new Set(["gamma"]),
      { custom: { skills: { gamma: { repoPath: "skills/engineering/gamma", category: "engineering" } } } },
    )

    expect(readFileSync(dir("active", "gamma", "SKILL.md"), "utf8")).toContain("Catalog source")
    expect(linked("gamma")).toBe(true)
  })
})

describe("installProjectDeck", () => {
  /** project deck を 1 枚置き、その置き場をサンドボックスへ向ける。 */
  function writeProjectDeck(name: string, skills: string[]): void {
    mkdirSync(dir("project-decks"), { recursive: true })
    writeFileSync(dir("project-decks", `${name}.json`), JSON.stringify({ name, skills }))
    setEnv("MY_SKILLS_PROJECT_DECKS_DIR", dir("project-decks"))
  }

  test("archive にある deck の skill を active へ戻す", () => {
    install("archive", "alpha")
    install("active", "beta")
    writeProjectDeck("api", ["alpha", "beta"])

    const result = installProjectDeck("api", lock)

    expect([...result.restore]).toEqual(["alpha"])
    expect([...result.alreadyActive]).toEqual(["beta"])
    expect(result.install.size).toBe(0)
    expect(existsSync(dir("active", "alpha"))).toBe(true)
    expect(linked("alpha")).toBe(true)
  })

  test("deck に無い active は archive へ落とさない", () => {
    install("active", "beta")
    install("archive", "alpha")
    writeProjectDeck("api", ["alpha"])

    installProjectDeck("api", lock)

    // CLI の install-deck は「足す」だけ。他の deck の作業中に足元を消さない。
    expect(existsSync(dir("active", "beta"))).toBe(true)
  })

  test("取得元の分からない skill があれば何も動かさない", () => {
    install("archive", "alpha")
    writeProjectDeck("api", ["alpha", "nowhere"])

    const result = installProjectDeck("api", lock)

    expect([...result.unresolved]).toEqual(["nowhere"])
    expect(result.restore.size).toBe(0)
    expect(existsSync(dir("archive", "alpha"))).toBe(true)
    expect(existsSync(dir("active", "alpha"))).toBe(false)
  })
})
