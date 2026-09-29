/**
 * Skill Replacement の退避・後始末・巻き戻しのテスト（ADR 0003）。
 *
 * 新しい skill の install 自体はここでは走らせない。install が active に置く状態を
 * fixture で作り、その前後で退避側が正しく片付く（または元に戻る）かだけを見る。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishReplacement,
  rollbackReplacement,
  setAsideForReplacement,
} from "./replacement";

let sandbox: string;
const touched: string[] = [];

const dir = (...parts: string[]) => join(sandbox, ...parts);

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

function place(where: "active" | "archive", name: string, body: string): void {
  mkdirSync(dir(where, name), { recursive: true });
  writeFileSync(dir(where, name, "SKILL.md"), body);
  if (where !== "active") return;
  for (const agent of ["claude-skills", "gemini-skills"])
    symlinkSync(dir("active", name), dir(agent, name));
}

function linked(name: string): boolean {
  return ["claude-skills", "gemini-skills"].every((agent) => {
    try {
      return lstatSync(dir(agent, name)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function body(where: "active" | "archive", name: string): string | null {
  const path = dir(where, name, "SKILL.md");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const LOCK = `${JSON.stringify(
  {
    version: 1,
    custom: { repo: "me/catalog", skills: {} },
    vendor: {},
    external: {
      alpha: { source: "old/repo", sourceUrl: "x", skillPath: "a" },
      beta: { source: "old/repo", sourceUrl: "x", skillPath: "b" },
    },
  },
  null,
  2
)}\n`;
const CLI_LOCK = `${JSON.stringify({ version: 1, skills: { alpha: { source: "old/repo" } } })}\n`;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-replacement-"));
  for (const sub of ["active", "archive", "claude-skills", "gemini-skills"])
    mkdirSync(dir(sub), { recursive: true });
  setEnv("MY_SKILLS_ACTIVE_DIR", dir("active"));
  setEnv("MY_SKILLS_ARCHIVE_DIR", dir("archive"));
  setEnv("MY_SKILLS_CLAUDE_SKILLS_DIR", dir("claude-skills"));
  setEnv("MY_SKILLS_GEMINI_SKILLS_DIR", dir("gemini-skills"));
  setEnv("MY_SKILLS_GLOBAL_LOCK_FILE", dir("cli-lock.json"));
  setEnv("MY_SKILLS_LOCK_FILE", dir("skills.lock.json"));
  writeFileSync(dir("skills.lock.json"), LOCK);
  writeFileSync(dir("cli-lock.json"), CLI_LOCK);
  writeFileSync(
    dir("trash-stub"),
    '#!/usr/bin/env bash\nset -euo pipefail\nfor path in "$@"; do rm -rf -- "$path"; done\n'
  );
  chmodSync(dir("trash-stub"), 0o755);
  setEnv("MY_SKILLS_TRASH_BIN", dir("trash-stub"));
});

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.length = 0;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("setAsideForReplacement", () => {
  test("既存を手元から退避し、lock のエントリを外す", () => {
    place("active", "alpha", "old alpha");
    place("archive", "beta", "old beta");

    const handle = setAsideForReplacement(["alpha", "beta"]);

    expect(handle.skills).toEqual([
      { name: "alpha", state: "active" },
      { name: "beta", state: "archive" },
    ]);
    expect(body("active", "alpha")).toBeNull();
    expect(body("archive", "beta")).toBeNull();
    expect(linked("alpha")).toBe(false);
    const lock = JSON.parse(readFileSync(dir("skills.lock.json"), "utf8"));
    expect(Object.keys(lock.external)).toEqual([]);
    rollbackReplacement(handle);
  });
});

describe("rollbackReplacement", () => {
  test("途中まで入った新しい skill を捨てて、既存と lock を元に戻す", () => {
    place("active", "alpha", "old alpha");
    place("archive", "beta", "old beta");
    const handle = setAsideForReplacement(["alpha", "beta"]);
    place("active", "alpha", "new alpha");
    writeFileSync(dir("cli-lock.json"), "{}");

    rollbackReplacement(handle);

    expect(body("active", "alpha")).toBe("old alpha");
    expect(body("archive", "beta")).toBe("old beta");
    expect(linked("alpha")).toBe(true);
    expect(readFileSync(dir("skills.lock.json"), "utf8")).toBe(LOCK);
    expect(readFileSync(dir("cli-lock.json"), "utf8")).toBe(CLI_LOCK);
  });
});

describe("finishReplacement", () => {
  test("Active/Archive の状態を新しい skill へ引き継ぎ、退避分を捨てる", () => {
    place("active", "alpha", "old alpha");
    place("archive", "beta", "old beta");
    const handle = setAsideForReplacement(["alpha", "beta"]);
    place("active", "alpha", "new alpha");
    place("active", "beta", "new beta");
    writeFileSync(
      dir("cli-lock.json"),
      JSON.stringify({
        version: 1,
        skills: { alpha: { source: "new/repo" }, beta: { source: "new/repo" } },
      })
    );

    finishReplacement(handle);

    expect(body("active", "alpha")).toBe("new alpha");
    expect(linked("alpha")).toBe(true);
    expect(body("active", "beta")).toBeNull();
    expect(body("archive", "beta")).toBe("new beta");
    expect(linked("beta")).toBe(false);
    const cli = JSON.parse(readFileSync(dir("cli-lock.json"), "utf8"));
    expect(Object.keys(cli.skills)).toEqual(["alpha"]);
    const stash = JSON.parse(
      readFileSync(dir("archive", ".cli-lock-stash.json"), "utf8")
    );
    expect(stash.beta).toEqual({ source: "new/repo" });
    expect(existsSync(handle.stashDir)).toBe(false);
  });
});
