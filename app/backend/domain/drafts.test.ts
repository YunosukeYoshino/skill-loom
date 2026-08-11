/**
 * draft の一覧と昇格のテスト。
 *
 * Draft は selected Catalog Root に置く。fixture は sandbox Catalog に閉じ込め、
 * 実在の draft と混ざらないよう `zz-unit-*` という名前だけを検査する。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { catalogRoot, draftSkillsDir } from "./config"
import { DraftConflictError, draftConflicts, draftRows, draftSkillCandidates, promoteDrafts } from "./drafts"
import { ValueError } from "./errors"
import type { Lock } from "./inventory"

const CATEGORY_A = "zz-unit-a"
const CATEGORY_B = "zz-unit-b"

let sandbox: string
const touched: string[] = []
/** 後始末で消すパス。trash ではなく直接消す（テストの副産物をゴミ箱に積まない）。 */
const created: string[] = []

function setEnv(name: string, value: string): void {
  touched.push(name)
  process.env[name] = value
}

const draftRoot = () => draftSkillsDir()
const catalogPath = (...parts: string[]) => join(catalogRoot(), ...parts)

/** `drafts/skills/{category}/{name}/SKILL.md` を置く。 */
function placeDraft(category: string, dirName: string, frontmatterName: string, description: string): void {
  const skillDir = join(draftRoot(), category, dirName)
  created.push(join(draftRoot(), category))
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${frontmatterName}\ndescription: ${description}\n---\n`)
}

function readLock(): Lock {
  return JSON.parse(readFileSync(join(sandbox, "skills.lock.json"), "utf8"))
}

const mine = (names: string[]) => names.filter((name) => name.startsWith("zz-unit-"))

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "drafts-unit-"))
  created.push(sandbox)
  writeFileSync(
    join(sandbox, "trash-stub"),
    "#!/usr/bin/env bash\nset -euo pipefail\nfor path in \"$@\"; do mv -- \"$path\" \"$path.trashed\"; done\n",
  )
  chmodSync(join(sandbox, "trash-stub"), 0o755)
  writeFileSync(
    join(sandbox, "skills.lock.json"),
    JSON.stringify({ version: 1, custom: { repo: "owner/catalog", skills: {} }, external: {}, vendor: {} }),
  )
  setEnv("MY_SKILLS_CATALOG_DIR", sandbox)
  setEnv("MY_SKILLS_LOCK_FILE", join(sandbox, "skills.lock.json"))
  setEnv("MY_SKILLS_TRASH_BIN", join(sandbox, "trash-stub"))
  // 昇格のたびに git が動くと、リポジトリの履歴にテストの副産物が残る。
  setEnv("MY_SKILLS_AUTO_COMMIT", "0")
})

afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name]
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("draftSkillCandidates", () => {
  test("frontmatter の name とカテゴリを拾う", () => {
    placeDraft(CATEGORY_A, "dir-name", "zz-unit-one", "最初の draft")

    const found = draftSkillCandidates().filter((candidate) => candidate.category === CATEGORY_A)
    expect(found).toEqual([
      {
        // ディレクトリ名ではなく frontmatter の name が優先される。
        name: "zz-unit-one",
        category: CATEGORY_A,
        repoPath: `drafts/skills/${CATEGORY_A}/dir-name`,
        description: "最初の draft",
      },
    ])
  })

  test("frontmatter に name が無ければディレクトリ名で代用する", () => {
    const skillDir = join(draftRoot(), CATEGORY_A, "zz-unit-nameless")
    created.push(join(draftRoot(), CATEGORY_A))
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: name 無し\n---\n")

    expect(mine(draftSkillCandidates().map((candidate) => candidate.name))).toEqual(["zz-unit-nameless"])
  })

  test("ディレクトリ名として使えない name はディレクトリ名で代用する", () => {
    // `..` を含む name を通すと、昇格先の `skills/{category}/{name}` が
    // リポジトリの外を指してしまう。
    placeDraft(CATEGORY_A, "zz-unit-escape", "../../../zz-unit-escaped", "traversal")

    const found = draftSkillCandidates().filter((candidate) => candidate.category === CATEGORY_A)
    expect(found.map((candidate) => candidate.name)).toEqual(["zz-unit-escape"])

    promoteDrafts(new Set(["zz-unit-escape"]))
    expect(existsSync(catalogPath("skills", CATEGORY_A, "zz-unit-escape", "SKILL.md"))).toBe(true)
    expect(existsSync(join(catalogRoot(), "..", "zz-unit-escaped"))).toBe(false)
  })

  test("SKILL.md の無いディレクトリは候補にしない", () => {
    created.push(join(draftRoot(), CATEGORY_A))
    mkdirSync(join(draftRoot(), CATEGORY_A, "zz-unit-empty"), { recursive: true })

    expect(mine(draftSkillCandidates().map((candidate) => candidate.name))).toEqual([])
  })

  test("カテゴリ順・ディレクトリ名順に並ぶ", () => {
    placeDraft(CATEGORY_B, "b-second", "zz-unit-b2", "")
    placeDraft(CATEGORY_A, "a-second", "zz-unit-a2", "")
    placeDraft(CATEGORY_A, "a-first", "zz-unit-a1", "")

    expect(mine(draftSkillCandidates().map((candidate) => candidate.name))).toEqual([
      "zz-unit-a1",
      "zz-unit-a2",
      "zz-unit-b2",
    ])
  })
})

describe("draftRows", () => {
  test("既に custom 登録済みの名前は draft として出さない", () => {
    placeDraft(CATEGORY_A, "kept", "zz-unit-kept", "残る")
    placeDraft(CATEGORY_A, "promoted", "zz-unit-promoted", "既に登録済み")

    const lock = { custom: { skills: { "zz-unit-promoted": { repoPath: "skills/x/y", category: "x" } } } } as Lock
    const rows = draftRows(lock).filter((row) => row.name.startsWith("zz-unit-"))
    expect(rows).toEqual([
      {
        name: "zz-unit-kept",
        category: CATEGORY_A,
        description: "残る",
        source: `drafts/skills/${CATEGORY_A}/kept`,
        state: "draft",
        checked: false,
      },
    ])
  })
})

describe("draftConflicts", () => {
  test("custom 登録済みか、配置先が埋まっていれば衝突", () => {
    const drafts = new Map([
      ["a", { name: "a", category: CATEGORY_A, repoPath: "", description: "" }],
      ["b", { name: "b", category: CATEGORY_A, repoPath: "", description: "" }],
    ])
    expect(draftConflicts(new Set(["a", "b"]), drafts, { b: {} })).toEqual(["b"])

    created.push(catalogPath("skills", CATEGORY_A))
    mkdirSync(catalogPath("skills", CATEGORY_A, "a"), { recursive: true })
    expect(draftConflicts(new Set(["a", "b"]), drafts, { b: {} })).toEqual(["a", "b"])
  })
})

describe("promoteDrafts", () => {
  test("コピー・lock 登録・draft 削除まで通す", () => {
    placeDraft(CATEGORY_A, "dir-name", "zz-unit-one", "昇格する")

    const [promoted, lock] = promoteDrafts(new Set(["zz-unit-one"]))

    expect(promoted).toEqual(["zz-unit-one"])
    expect(lock.custom?.skills?.["zz-unit-one"]).toEqual({
      repoPath: `skills/${CATEGORY_A}/zz-unit-one`,
      category: CATEGORY_A,
    })
    // ディレクトリ名ではなく skill 名で配置される。
    expect(existsSync(catalogPath("skills", CATEGORY_A, "zz-unit-one", "SKILL.md"))).toBe(true)
    expect(existsSync(join(draftRoot(), CATEGORY_A, "dir-name"))).toBe(false)
    expect(readLock().custom?.skills?.["zz-unit-one"]).toBeDefined()
  })

  test("未選択と未知の名前は ValueError", () => {
    expect(() => promoteDrafts(new Set())).toThrow(ValueError)
    expect(() => promoteDrafts(new Set(["zz-unit-missing"]))).toThrow("Unknown drafts: zz-unit-missing")
  })

  test("配置先が埋まっていれば force 無しでは DraftConflictError", () => {
    placeDraft(CATEGORY_A, "zz-unit-one", "zz-unit-one", "衝突する")
    created.push(catalogPath("skills", CATEGORY_A))
    mkdirSync(catalogPath("skills", CATEGORY_A, "zz-unit-one"), { recursive: true })
    writeFileSync(catalogPath("skills", CATEGORY_A, "zz-unit-one", "SKILL.md"), "既存\n")

    try {
      promoteDrafts(new Set(["zz-unit-one"]))
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(DraftConflictError)
      expect((error as DraftConflictError).names).toEqual(["zz-unit-one"])
    }
    // 弾いたときは何も動かさない。draft も配置先もそのまま。
    expect(existsSync(join(draftRoot(), CATEGORY_A, "zz-unit-one"))).toBe(true)
    expect(readFileSync(catalogPath("skills", CATEGORY_A, "zz-unit-one", "SKILL.md"), "utf8")).toBe("既存\n")
  })

  test("force なら配置先を捨てて上書きする", () => {
    placeDraft(CATEGORY_A, "zz-unit-one", "zz-unit-one", "上書きする")
    created.push(catalogPath("skills", CATEGORY_A))
    mkdirSync(catalogPath("skills", CATEGORY_A, "zz-unit-one"), { recursive: true })
    writeFileSync(catalogPath("skills", CATEGORY_A, "zz-unit-one", "SKILL.md"), "既存\n")

    expect(promoteDrafts(new Set(["zz-unit-one"]), true)[0]).toEqual(["zz-unit-one"])
    expect(readFileSync(catalogPath("skills", CATEGORY_A, "zz-unit-one", "SKILL.md"), "utf8")).toContain(
      "上書きする",
    )
  })
})
