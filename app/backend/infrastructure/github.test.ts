/**
 * source の正規化と SKILL.md の発見規則のテスト。
 *
 * 発見規則が `bunx skills` とズレると、更新確認だけが別の SKILL.md を見て
 * 「更新あり」を出し続ける。優先度と 2 階層下の扱いを 1 ケースずつ固定する。
 * ネットワークへ出る関数はここでは触らない。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ValueError } from "../domain/errors"
import {
  discoverExternalSkillCandidates,
  findCliSkillMdPaths,
  githubRawSkillUrl,
  normalizeGithubSource,
  skillMdFolderPath,
  skillMdPathPriority,
  uniqueExternalSkillCandidates,
} from "./github"

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-github-"))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/** SKILL.md を 1 枚置く。frontmatter が無いものは候補にならない。 */
function placeSkill(relativeDir: string, name: string, description = ""): void {
  const dir = join(sandbox, relativeDir)
  mkdirSync(dir, { recursive: true })
  const frontmatter = name ? `---\nname: ${name}\ndescription: ${description}\n---\n` : "no frontmatter\n"
  writeFileSync(join(dir, "SKILL.md"), frontmatter)
}

describe("normalizeGithubSource", () => {
  test("URL でも owner/repo でも同じ形になる", () => {
    for (const source of [
      "owner/repo",
      "  owner/repo  ",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo/",
      "http://github.com/owner/repo",
    ]) {
      expect(normalizeGithubSource(source)).toBe("owner/repo")
    }
  })

  test("owner/repo に落とせない入力は ValueError（呼び出し側は 400）", () => {
    for (const source of ["notarepo", "", "owner/repo/extra", "https://gitlab.com/owner/repo"]) {
      expect(() => normalizeGithubSource(source)).toThrow(ValueError)
    }
  })
})

describe("skillMdFolderPath", () => {
  test("SKILL.md を落としてフォルダのパスにする（tree SHA の比較キー）", () => {
    expect(skillMdFolderPath("skills/alpha/SKILL.md")).toBe("skills/alpha")
    expect(skillMdFolderPath("skills/alpha/skill.md")).toBe("skills/alpha")
    expect(skillMdFolderPath("SKILL.md")).toBe("")
    expect(skillMdFolderPath("skills\\alpha\\SKILL.md")).toBe("skills/alpha")
  })
})

describe("githubRawSkillUrl", () => {
  test("HEAD 固定の raw URL を組み立てる", () => {
    // HTTP seam はネットワークをスタブ化するので、URL の形までは検査できない。
    // 綴りが変わると GitHub が 404 を返すので、公開インターフェースとして固定する。
    expect(githubRawSkillUrl("owner-one/repo-one", "skills/alpha/SKILL.md")).toBe(
      "https://raw.githubusercontent.com/owner-one/repo-one/HEAD/skills/alpha/SKILL.md",
    )
  })

  test("前後の余分なスラッシュは詰める", () => {
    expect(githubRawSkillUrl("owner/repo", "/skills///x/SKILL.md")).toBe(
      "https://raw.githubusercontent.com/owner/repo/HEAD/skills/x/SKILL.md",
    )
  })
})

describe("skillMdPathPriority", () => {
  test("prefix 無しは repo 直下と 1 階層下だけが最優先になる", () => {
    expect(skillMdPathPriority("SKILL.md")[0]).toBe(0)
    expect(skillMdPathPriority("alpha/SKILL.md")[0]).toBe(0)
    // 深いパスは prefix 無しの枠には入らない。
    expect(skillMdPathPriority("docs/alpha/SKILL.md")[0]).toBeGreaterThan(0)
  })

  test("`skills/` は `.claude/skills/` より優先される", () => {
    expect(skillMdPathPriority("skills/alpha/SKILL.md")[0]).toBeLessThan(
      skillMdPathPriority(".claude/skills/alpha/SKILL.md")[0],
    )
  })
})

describe("uniqueExternalSkillCandidates", () => {
  test("同名は優先度の高いパスだけ残る。並びは最初に見つかった順", () => {
    const unique = uniqueExternalSkillCandidates([
      { name: "beta", path: ".claude/skills/beta/SKILL.md" },
      { name: "alpha", path: ".claude/skills/alpha/SKILL.md" },
      { name: "alpha", path: "skills/alpha/SKILL.md" },
      { name: "", path: "skills/nameless/SKILL.md" },
    ])
    expect(unique).toEqual([
      { name: "beta", path: ".claude/skills/beta/SKILL.md" },
      { name: "alpha", path: "skills/alpha/SKILL.md" },
    ])
  })
})

describe("findCliSkillMdPaths", () => {
  const blob = (path: string) => ({ type: "blob", path })

  test("prefix 配下の直下と 1 階層下を拾う", () => {
    const tree = [blob("skills/alpha/SKILL.md"), blob("skills/beta/SKILL.md"), blob("README.md")]
    expect(findCliSkillMdPaths(tree)).toEqual(["skills/alpha/SKILL.md", "skills/beta/SKILL.md"])
  })

  test("2 階層下は親に SKILL.md が無いときだけ拾う", () => {
    const withParent = [blob("skills/alpha/SKILL.md"), blob("skills/alpha/nested/SKILL.md")]
    expect(findCliSkillMdPaths(withParent)).toEqual(["skills/alpha/SKILL.md"])

    const withoutParent = [blob("skills/alpha/nested/SKILL.md")]
    expect(findCliSkillMdPaths(withoutParent)).toEqual(["skills/alpha/nested/SKILL.md"])
  })

  test("node_modules などは 2 階層下の対象から外す", () => {
    // `skills/alpha/SKILL.md` が優先度パスに乗るので、fallback は走らない。
    // node_modules 側が落ちていることをここで確かめる。
    const tree = [blob("skills/alpha/SKILL.md"), blob("skills/node_modules/pkg/SKILL.md")]
    expect(findCliSkillMdPaths(tree)).toEqual(["skills/alpha/SKILL.md"])
  })

  test("優先 prefix にどれも当たらなければ、浅いパスだけを返す", () => {
    const tree = [blob("docs/a/b/SKILL.md"), blob("docs/a/b/c/d/e/SKILL.md")]
    expect(findCliSkillMdPaths(tree)).toEqual(["docs/a/b/SKILL.md"])
  })
})

describe("discoverExternalSkillCandidates", () => {
  test("frontmatter の name が無いもの、テスト用ディレクトリのものは候補にしない", () => {
    placeSkill("skills/alpha", "alpha", "Alpha skill")
    placeSkill("skills/nameless", "")
    placeSkill("tests/fixture-skill", "should-not-appear")

    const candidates = discoverExternalSkillCandidates(sandbox)
    expect(candidates.map((candidate) => candidate.name)).toEqual(["alpha"])
    expect(candidates[0]?.description).toBe("Alpha skill")
    expect(candidates[0]?.path).toBe(join("skills", "alpha", "SKILL.md"))
    // 更新判定に使うので、内容ハッシュは必ず埋まっていること。
    expect(candidates[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("同名が 2 か所にあれば優先度の高い方だけ残る", () => {
    placeSkill("skills/alpha", "alpha", "from skills/")
    placeSkill(".claude/skills/alpha", "alpha", "from .claude/")

    const candidates = discoverExternalSkillCandidates(sandbox)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.description).toBe("from skills/")
  })
})
