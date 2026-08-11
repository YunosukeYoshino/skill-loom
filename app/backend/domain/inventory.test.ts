/**
 * Inventory 読み取りのうち、移植で壊しやすい判定だけを固定する。
 *
 * payload 全体の一致は E2E（`tests/`）と Python との突き合わせで見ているので、
 * ここは「なぜその値になるのか」が読み取りにくい箇所に絞る。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  frontmatterDescription,
  hiddenGlobalSkills,
  installedNames,
  loadLock,
  type Lock,
  repoLocalCustomSkills,
  skillDescription,
  trackedSkills,
} from "./inventory"

let sandbox: string
const touched: string[] = []

function setEnv(name: string, value: string): void {
  touched.push(name)
  process.env[name] = value
}

function writeSkill(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), body)
  return join(dir, "SKILL.md")
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-inventory-"))
  setEnv("MY_SKILLS_ACTIVE_DIR", join(sandbox, "active"))
  setEnv("MY_SKILLS_ARCHIVE_DIR", join(sandbox, "archive"))
  setEnv("MY_SKILLS_IGNORE_FILE", join(sandbox, "ignore.json"))
})

afterEach(() => {
  for (const name of touched) delete process.env[name]
  touched.length = 0
  rmSync(sandbox, { recursive: true, force: true })
})

describe("installedNames", () => {
  test("symlink 先がディレクトリなら数える（Projection は symlink を張るため）", () => {
    const real = join(sandbox, "real", "linked")
    mkdirSync(real, { recursive: true })
    mkdirSync(join(sandbox, "active"), { recursive: true })
    symlinkSync(real, join(sandbox, "active", "linked"))

    expect(installedNames(join(sandbox, "active"))).toEqual(new Set(["linked"]))
  })

  test("壊れた symlink は数えない", () => {
    mkdirSync(join(sandbox, "active"), { recursive: true })
    symlinkSync(join(sandbox, "nope"), join(sandbox, "active", "broken"))

    expect(installedNames(join(sandbox, "active"))).toEqual(new Set())
  })

  test(".system とファイルは除外する", () => {
    mkdirSync(join(sandbox, "active", ".system"), { recursive: true })
    mkdirSync(join(sandbox, "active", "real-skill"), { recursive: true })
    writeFileSync(join(sandbox, "active", "stray.txt"), "")

    expect(installedNames(join(sandbox, "active"))).toEqual(new Set(["real-skill"]))
  })

  test("ディレクトリが無ければ空", () => {
    expect(installedNames(join(sandbox, "missing"))).toEqual(new Set())
  })
})

describe("loadLock", () => {
  test("selected Catalog の不正な Lock をファイル名つきで拒否する", () => {
    const path = join(sandbox, "skills.lock.json")
    setEnv("MY_SKILLS_LOCK_FILE", path)
    writeFileSync(
      path,
      JSON.stringify({ version: 2, custom: { repo: "owner/catalog", skills: {} }, external: {}, vendor: {} }),
    )

    expect(() => loadLock()).toThrow(`${path}.version: unsupported version 2; expected 1`)
  })

  test("壊れた JSON をファイル名つきで拒否する", () => {
    const path = join(sandbox, "skills.lock.json")
    setEnv("MY_SKILLS_LOCK_FILE", path)
    writeFileSync(path, "{")

    expect(() => loadLock()).toThrow(`${path}: invalid JSON`)
  })
})

describe("frontmatterDescription", () => {
  test("1 行の description をそのまま返す", () => {
    const path = writeSkill(join(sandbox, "s"), "---\nname: s\ndescription: ふつうの説明\n---\n")
    expect(frontmatterDescription(path)).toBe("ふつうの説明")
  })

  test("値の中のコロンで切らない", () => {
    const path = writeSkill(join(sandbox, "s"), '---\ndescription: "引用符つき: コロン入り"\n---\n')
    expect(frontmatterDescription(path)).toBe("引用符つき: コロン入り")
  })

  test("ブロックスカラーは字下げが続く間だけ拾って 1 行に畳む", () => {
    const path = writeSkill(join(sandbox, "s"), "---\ndescription: >\n  折り返した\n  2 行目\nname: s\n---\n")
    expect(frontmatterDescription(path)).toBe("折り返した 2 行目")
  })

  test("ブロックスカラーの記号 4 種を受ける", () => {
    for (const marker of [">", "|", ">-", "|-"]) {
      const path = writeSkill(join(sandbox, `s-${marker.length}-${marker[0]}`), `---\ndescription: ${marker}\n  値\n---\n`)
      expect(frontmatterDescription(path)).toBe("値")
    }
  })

  test("frontmatter が無ければ空文字", () => {
    const path = writeSkill(join(sandbox, "s"), "no frontmatter here\n")
    expect(frontmatterDescription(path)).toBe("")
  })

  test("ファイルが無ければ空文字", () => {
    expect(frontmatterDescription(join(sandbox, "nope", "SKILL.md"))).toBe("")
  })

  test("CRLF でも読める", () => {
    const path = writeSkill(join(sandbox, "s"), "---\r\ndescription: CRLF\r\n---\r\n")
    expect(frontmatterDescription(path)).toBe("CRLF")
  })
})

describe("skillDescription", () => {
  test("Custom Skill の description は selected Catalog から読む", () => {
    const catalog = join(sandbox, "catalog")
    setEnv("MY_SKILLS_CATALOG_DIR", catalog)
    writeSkill(
      join(catalog, "skills", "engineering", "catalog-skill"),
      "---\nname: catalog-skill\ndescription: Catalog description\n---\n",
    )
    const lock: Lock = {
      custom: { skills: { "catalog-skill": { repoPath: "skills/engineering/catalog-skill" } } },
    }

    expect(skillDescription(lock, "catalog-skill")).toBe("Catalog description")
  })
})

describe("非表示と追跡対象", () => {
  const lock: Lock = {
    custom: {
      repo: "owner/catalog",
      skills: {
        alpha: { repoPath: "skills/a/alpha" },
        repolocal: { repoPath: ".agents/skills/repolocal" },
      },
    },
    external: { "ext-one": { source: "owner/repo" }, "hidden-ignored": { source: "owner/repo" } },
  }

  test("repoPath が .agents/skills/ 配下なら管理用として隠す", () => {
    expect(repoLocalCustomSkills(lock)).toEqual(new Set(["repolocal"]))
  })

  test("ignore 指定は tracked から外れ、表示からも隠れる", () => {
    writeFileSync(join(sandbox, "ignore.json"), JSON.stringify({ ignore: ["hidden-ignored"] }))

    expect(trackedSkills(lock)).toEqual(new Set(["alpha", "ext-one"]))
    expect(hiddenGlobalSkills(lock).has("hidden-ignored")).toBe(true)
    expect(hiddenGlobalSkills(lock).has("repolocal")).toBe(true)
  })

  test("ignore ファイルが無ければ ignore 指定なし扱い", () => {
    expect(trackedSkills(lock)).toEqual(new Set(["alpha", "ext-one", "hidden-ignored"]))
  })
})
