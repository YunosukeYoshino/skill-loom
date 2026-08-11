/**
 * custom skill の drift 検出と上書きのテスト。
 *
 * `repoPath` は REPO_ROOT 相対でしか解決できないので、リポジトリ内の
 * `tests/tmp/` 配下に実体を置き、終わったら必ず片付ける。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./config";
import {
  collectCustomUpdatable,
  customSkillDrift,
  customSkillRepoDir,
  installedCustomSkillLocation,
  skillMdUnifiedDiff,
  skillTreeFileMap,
  updateCustomFromRepo,
} from "./custom";
import type { Lock } from "./inventory";

let sandbox: string;
let repoFixture: string;
const touched: string[] = [];

const dir = (...parts: string[]) => join(sandbox, ...parts);

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

function writeFile(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/** repo 側と展開側の SKILL.md を書き、lock を組み立てる。 */
function place(
  name: string,
  repoBody: string,
  installedBody: string | null,
  where: "active" | "archive" = "active"
): void {
  writeFile(join(repoFixture, name, "SKILL.md"), repoBody);
  if (installedBody !== null)
    writeFile(dir(where, name, "SKILL.md"), installedBody);
}

function lockFor(...names: string[]): Lock {
  const skills: Record<string, { repoPath: string; category: string }> = {};
  for (const name of names) {
    skills[name] = {
      repoPath: `tests/tmp/custom-unit/${name}`,
      category: "unit",
    };
  }
  return { custom: { skills } };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-custom-"));
  for (const sub of ["active", "archive", "claude", "gemini"])
    mkdirSync(dir(sub), { recursive: true });
  repoFixture = join(REPO_ROOT, "tests", "tmp", "custom-unit");
  mkdirSync(repoFixture, { recursive: true });
  setEnv("MY_SKILLS_ACTIVE_DIR", dir("active"));
  setEnv("MY_SKILLS_ARCHIVE_DIR", dir("archive"));
  setEnv("MY_SKILLS_CLAUDE_SKILLS_DIR", dir("claude"));
  setEnv("MY_SKILLS_GEMINI_SKILLS_DIR", dir("gemini"));
});

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.length = 0;
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(repoFixture, { recursive: true, force: true });
});

describe("customSkillRepoDir / installedCustomSkillLocation", () => {
  test("repoPath が無い・実体が無い場合は null", () => {
    place("alpha", "repo\n", "installed\n");
    expect(customSkillRepoDir(lockFor("alpha"), "alpha")).toBe(
      join(repoFixture, "alpha")
    );
    expect(customSkillRepoDir(lockFor("alpha"), "missing")).toBeNull();
    expect(
      customSkillRepoDir(
        { custom: { skills: { beta: { repoPath: "tests/tmp/nope" } } } },
        "beta"
      )
    ).toBeNull();
  });

  test("active を先に見る。どちらにも無ければ missing", () => {
    place("alpha", "repo\n", "installed\n");
    place("beta", "repo\n", "installed\n", "archive");

    expect(installedCustomSkillLocation("alpha")).toEqual([
      dir("active", "alpha"),
      "active",
    ]);
    expect(installedCustomSkillLocation("beta")).toEqual([
      dir("archive", "beta"),
      "archive",
    ]);
    expect(installedCustomSkillLocation("gamma")).toEqual([null, "missing"]);
  });

  test("Catalog Root 外の repoPath は拒否する", () => {
    mkdirSync(dir("catalog"));
    writeFile(dir("outside", "SKILL.md"), "outside\n");
    setEnv("MY_SKILLS_CATALOG_DIR", dir("catalog"));
    const lock: Lock = {
      custom: { skills: { escaped: { repoPath: "../outside" } } },
    };

    expect(() => customSkillRepoDir(lock, "escaped")).toThrow(
      "Catalog path must stay within Catalog Root"
    );
  });
});

describe("skillTreeFileMap", () => {
  test("入れ子も相対パスで平らに並べる。ディレクトリ自体は入らない", () => {
    const root = dir("tree");
    writeFile(join(root, "SKILL.md"), "a\n");
    writeFile(join(root, "scripts", "run.sh"), "b\n");

    expect([...skillTreeFileMap(root).keys()].sort()).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
    expect(skillTreeFileMap(dir("no-such-dir")).size).toBe(0);
  });

  test("symlink の先へは降りない", () => {
    const root = dir("tree2");
    writeFile(join(root, "SKILL.md"), "a\n");
    writeFile(dir("outside", "deep", "x.md"), "x\n");
    symlinkSync(dir("outside"), join(root, "linked"));

    expect([...skillTreeFileMap(root).keys()]).toEqual(["SKILL.md"]);
  });
});

describe("skillMdUnifiedDiff", () => {
  test("同じなら空、違えば installed → repo の向きで出す", () => {
    place(
      "alpha",
      "---\nname: alpha\ndescription: repo version\n---\n",
      "---\nname: alpha\ndescription: installed version\n---\n"
    );
    const diff = skillMdUnifiedDiff(
      dir("active", "alpha"),
      join(repoFixture, "alpha")
    );

    expect(diff).toContain("--- installed/alpha/SKILL.md");
    expect(diff).toContain("+++ repo/alpha/SKILL.md");
    expect(diff).toContain("-description: installed version");
    expect(diff).toContain("+description: repo version");

    place("beta", "same\n", "same\n");
    expect(
      skillMdUnifiedDiff(dir("active", "beta"), join(repoFixture, "beta"))
    ).toBe("");
  });
});

describe("customSkillDrift / collectCustomUpdatable", () => {
  test("SKILL.md 以外の差分は otherChangedFiles に出る", () => {
    place("alpha", "same\n", "same\n");
    writeFile(join(repoFixture, "alpha", "scripts", "run.sh"), "new\n");
    writeFile(dir("active", "alpha", "scripts", "run.sh"), "old\n");

    const drift = customSkillDrift(lockFor("alpha"), "alpha");
    expect(drift).toMatchObject({
      name: "alpha",
      state: "active",
      repoPath: "tests/tmp/custom-unit/alpha",
      // SKILL.md は同じなので diff は空。ここに何か出ると UI が空の差分を開く。
      skillDiff: "",
      otherChangedFiles: ["scripts/run.sh"],
    });
  });

  test("展開されていない skill は drift にならない", () => {
    place("alpha", "repo\n", null);
    expect(customSkillDrift(lockFor("alpha"), "alpha")).toBeNull();
  });

  test("差分のあるものだけを名前順で返す", () => {
    place("beta", "repo\n", "installed\n");
    place("alpha", "same\n", "same\n");
    place("gamma", "repo\n", "installed\n", "archive");

    expect(
      collectCustomUpdatable(lockFor("alpha", "beta", "gamma")).map(
        (row) => row.name
      )
    ).toEqual(["beta", "gamma"]);
  });
});

describe("updateCustomFromRepo", () => {
  test("展開先の場所を保ったまま repo の内容で置き換える", () => {
    place("alpha", "repo alpha\n", "installed alpha\n");
    place("beta", "repo beta\n", "installed beta\n", "archive");
    // repo 側から消えたファイルは、上書き後に残ってはいけない。
    writeFile(dir("active", "alpha", "stale.md"), "stale\n");

    expect(
      updateCustomFromRepo(new Set(["beta", "alpha"]), lockFor("alpha", "beta"))
    ).toEqual(["alpha", "beta"]);

    expect(readFileSync(dir("active", "alpha", "SKILL.md"), "utf-8")).toBe(
      "repo alpha\n"
    );
    expect(() =>
      readFileSync(dir("active", "alpha", "stale.md"), "utf-8")
    ).toThrow();
    // archive のものは archive のまま。active へ引き上げると projection が変わる。
    expect(readFileSync(dir("archive", "beta", "SKILL.md"), "utf-8")).toBe(
      "repo beta\n"
    );
    expect(() =>
      readFileSync(dir("active", "beta", "SKILL.md"), "utf-8")
    ).toThrow();
  });

  test("active なら agent 用の symlink を張り直す", () => {
    place("alpha", "repo alpha\n", "installed alpha\n");
    updateCustomFromRepo(new Set(["alpha"]), lockFor("alpha"));

    expect(readFileSync(dir("claude", "alpha", "SKILL.md"), "utf-8")).toBe(
      "repo alpha\n"
    );
  });

  test("repo に無い・展開されていないものは例外", () => {
    place("alpha", "repo\n", null);
    expect(() =>
      updateCustomFromRepo(new Set(["alpha"]), lockFor("alpha"))
    ).toThrow("not installed");
    expect(() =>
      updateCustomFromRepo(new Set(["ghost"]), lockFor("ghost"))
    ).toThrow("source not found");
  });
});
