/**
 * check-skills のパリティテスト。
 *
 * Python 版 check-skills.py の公開関数（repo_defaults / classify / load_ignore /
 * load_lock_ignored）の意味論を保持していることを、Bun の test runner で検証する。
 * 期待値は既存の挙動から導出したリテラルを使う。
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classify,
  loadIgnore,
  loadLockIgnored,
  repoDefaults,
} from "./check-skills";

describe("repoDefaults", () => {
  test("MY_SKILLS_CATALOG_DIR が無い場合はリポジトリ root のファイルを返す", () => {
    const prev = process.env.MY_SKILLS_CATALOG_DIR;
    delete process.env.MY_SKILLS_CATALOG_DIR;
    try {
      const defaults = repoDefaults();
      // テスト実行時は engine リポジトリ root が skills.lock.json を含むため、
      // ルート配下の lock_file / ignore_file になる。
      expect(defaults.lockFile.endsWith("skills.lock.json")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.MY_SKILLS_CATALOG_DIR = prev;
    }
  });

  test("MY_SKILLS_CATALOG_DIR を優先する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cks-"));
    const catalog = path.join(dir, "catalog");
    fs.mkdirSync(catalog);
    const prev = process.env.MY_SKILLS_CATALOG_DIR;
    process.env.MY_SKILLS_CATALOG_DIR = catalog;
    try {
      const defaults = repoDefaults();
      expect(defaults.lockFile).toBe(
        path.resolve(catalog) + "/skills.lock.json"
      );
      expect(defaults.ignoreFile).toBe(
        path.resolve(catalog) + "/.skills-ignore.json"
      );
    } finally {
      if (prev !== undefined) process.env.MY_SKILLS_CATALOG_DIR = prev;
      else delete process.env.MY_SKILLS_CATALOG_DIR;
    }
  });
});

describe("classify", () => {
  test("custom / external / ignored / unmanaged を分類する", () => {
    const lock = {
      custom: {
        repo: "owner/catalog",
        skills: { alpha: { repoPath: "skills/a/alpha", category: "a" } },
      },
      external: { beta: { source: "owner/repo" } },
      vendor: {},
    };
    const result = classify(
      lock,
      new Set(["superpowers"]),
      new Set(["alpha", "beta", "superpowers", "unknown"]),
      new Set(["alpha", "unknown"])
    );
    expect(result.custom["alpha"]).toEqual({ agents: true, claude: true });
    expect(result.external["owner/repo"]?.[0]?.name).toBe("beta");
    expect(result.ignored.has("superpowers")).toBe(true);
    expect(result.unmanagedAgents.has("unknown")).toBe(true);
    expect(result.unmanagedClaude.has("unknown")).toBe(true);
  });

  test("lock の ignored 配列は ignored として扱う", () => {
    const lock = {
      custom: { repo: "owner/catalog", skills: {} },
      external: {},
      vendor: {},
      ignored: ["plugin-skill"],
    };
    const result = classify(
      lock,
      new Set(),
      new Set(["plugin-skill"]),
      new Set()
    );
    expect(result.ignored.has("plugin-skill")).toBe(true);
    expect(result.unmanagedAgents.has("plugin-skill")).toBe(false);
  });
});

describe("loadIgnore / loadLockIgnored", () => {
  test("load_ignore は .skills-ignore.json の ignore 配列を返す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckig-"));
    const ignoreFile = path.join(dir, ".skills-ignore.json");
    fs.writeFileSync(ignoreFile, JSON.stringify({ ignore: ["superpowers"] }));
    expect(loadIgnore(ignoreFile)).toEqual(new Set(["superpowers"]));
  });

  test("load_lock_ignored は lock の ignored 配列を返す", () => {
    expect(loadLockIgnored({ ignored: ["plugin-skill"] })).toEqual(
      new Set(["plugin-skill"])
    );
  });
});
