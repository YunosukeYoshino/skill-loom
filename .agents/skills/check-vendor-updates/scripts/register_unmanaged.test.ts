/**
 * register-unmanaged のパリティテスト。
 *
 * Python 版 register_unmanaged.py の公開関数（is_custom_skill / build_custom_entry /
 * get_repo_root）の意味論を保持していることを、Bun の test runner で検証する。
 * 期待値は既存の挙動から導出したリテラルを使う。
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildCustomEntry, getRepoRoot, isCustomSkill } from "./register_unmanaged"

describe("is_custom_skill", () => {
  test("global lock が無い状態で custom と断定しない", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ru-c1-"))
    expect(isCustomSkill("external-only", dir, {}, "owner/catalog")).toBe(false)
  })

  test("global lock source が catalog repo から始まれば custom と判定", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ru-c2-"))
    const globalLock = { "catalog-skill": { source: "owner/catalog" } }
    expect(isCustomSkill("catalog-skill", dir, globalLock as never, "owner/catalog")).toBe(true)
  })
})

describe("build_custom_entry", () => {
  test("repo source が見つからなければ null を返す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ru-b-"))
    expect(buildCustomEntry("missing-skill", dir, {})).toBeNull()
  })
})

describe("get_repo_root", () => {
  test("selected catalog は legacy repo root に優先する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ru-g-"))
    const catalog = path.join(dir, "catalog")
    const legacy = path.join(dir, "legacy")
    fs.mkdirSync(catalog)
    fs.mkdirSync(legacy)
    const prevCatalog = process.env.MY_SKILLS_CATALOG_DIR
    const prevRepo = process.env.REPO_ROOT
    process.env.MY_SKILLS_CATALOG_DIR = catalog
    process.env.REPO_ROOT = legacy
    try {
      expect(getRepoRoot()).toBe(path.resolve(catalog))
    } finally {
      if (prevCatalog !== undefined) process.env.MY_SKILLS_CATALOG_DIR = prevCatalog
      else delete process.env.MY_SKILLS_CATALOG_DIR
      if (prevRepo !== undefined) process.env.REPO_ROOT = prevRepo
      else delete process.env.REPO_ROOT
    }
  })
})