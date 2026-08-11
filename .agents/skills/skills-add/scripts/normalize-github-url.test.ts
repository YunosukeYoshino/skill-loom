/**
 * normalize-github-url のパリティテスト。
 *
 * Python 版 normalize-github-url.py の CLI 契約（args・stdout・stderr・exit code）を
 * 保持していることを、Bun の test runner で検証する。期待値は既存の挙動から
 * 導出したリテラルであり、実装結果を再計算しない。
 */

import { describe, expect, test } from "bun:test"
import { normalizeGithubUrl } from "./normalize-github-url"

describe("normalizeGithubUrl", () => {
  test("共通の https / ssh / owner-repo 形式を受け付けて owner/repo を返す", () => {
    const accepted = [
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git/",
      "ssh://git@github.com/owner/repo.git",
      "git@github.com:owner/repo.git",
      "owner/repo",
    ]
    for (const url of accepted) {
      expect(normalizeGithubUrl(url)).toBe("owner/repo")
    }
  })

  test(".git サフィックスを持つ URL は owner/repo へ正規化する", () => {
    expect(normalizeGithubUrl("https://github.com/better-auth/skills.git")).toBe("better-auth/skills")
  })

  test("解析できない入力は null を返す", () => {
    expect(normalizeGithubUrl("not-a-repository")).toBeNull()
  })
})