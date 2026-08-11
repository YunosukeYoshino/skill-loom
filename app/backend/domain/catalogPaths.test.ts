import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveCatalogPath } from "./catalogPaths"

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.MY_SKILLS_CATALOG_DIR
  for (const path of tempDirs.splice(0)) Bun.spawnSync(["/usr/bin/trash", path])
})

describe("resolveCatalogPath", () => {
  test("absolute paths are rejected", () => {
    process.env.MY_SKILLS_CATALOG_DIR = "/tmp/catalog"

    expect(() => resolveCatalogPath("/tmp/outside/SKILL.md")).toThrow("Catalog path must be relative")
  })

  test("parent traversal outside the Catalog Root is rejected", () => {
    process.env.MY_SKILLS_CATALOG_DIR = "/tmp/catalog"

    expect(() => resolveCatalogPath("../outside/SKILL.md")).toThrow("Catalog path must stay within Catalog Root")
  })

  test("symlinks that resolve outside the Catalog Root are rejected", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "catalog-paths-"))
    tempDirs.push(sandbox)
    const catalog = join(sandbox, "catalog")
    const outside = join(sandbox, "outside")
    mkdirSync(catalog)
    mkdirSync(outside)
    symlinkSync(outside, join(catalog, "escape"), "dir")
    process.env.MY_SKILLS_CATALOG_DIR = catalog

    expect(() => resolveCatalogPath("escape/SKILL.md")).toThrow("Catalog path must stay within Catalog Root")
  })
})
