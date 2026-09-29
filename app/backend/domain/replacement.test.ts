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
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitReplacement,
  installExternalSelection,
  finishReplacement,
  recoverPendingReplacements,
  replaceWhileInstalling,
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

function readJsonFile(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
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
  test("既存を archive 配下の退避所へ移し、journal を先に書いて lock のエントリを外す", () => {
    place("active", "alpha", "old alpha");
    place("archive", "beta", "old beta");

    const handle = setAsideForReplacement(["alpha", "beta"]);

    expect(handle.dir.startsWith(dir("archive", ".replace"))).toBe(true);
    const journal = readJsonFile(join(handle.dir, "journal.json"));
    expect(journal.phase).toBe("prepared");
    expect(journal.rows).toEqual([
      {
        name: "alpha",
        state: "active",
        lockEntry: { source: "old/repo", sourceUrl: "x", skillPath: "a" },
        cliLockEntry: { source: "old/repo" },
      },
      {
        name: "beta",
        state: "archive",
        lockEntry: { source: "old/repo", sourceUrl: "x", skillPath: "b" },
        cliLockEntry: null,
      },
    ]);
    expect(body("active", "alpha")).toBeNull();
    expect(body("archive", "beta")).toBeNull();
    expect(readFileSync(join(handle.dir, "alpha", "SKILL.md"), "utf8")).toBe(
      "old alpha"
    );
    expect(linked("alpha")).toBe(false);
    const lock = readJsonFile(dir("skills.lock.json"));
    expect(Object.keys(lock.external)).toEqual([]);
    rollbackReplacement(handle);
  });

  test("規約外の名前はファイルに触れる前に拒否する", () => {
    expect(() => setAsideForReplacement([".."])).toThrow(
      "Invalid external skill name: .."
    );
    expect(existsSync(dir("archive", ".replace"))).toBe(false);
  });

  test("Active と Archive の両方に同名があれば拒否する", () => {
    place("active", "alpha", "old alpha");
    place("archive", "alpha", "older alpha");

    expect(() => setAsideForReplacement(["alpha"])).toThrow(
      "alpha is in both Active and Archive"
    );
    expect(body("active", "alpha")).toBe("old alpha");
    expect(body("archive", "alpha")).toBe("older alpha");
  });
});

describe("rollbackReplacement", () => {
  test("途中まで入った新しい skill を捨てて、既存と lock のエントリを元に戻す", () => {
    place("active", "alpha", "old alpha");
    place("archive", "beta", "old beta");
    const handle = setAsideForReplacement(["alpha", "beta"]);
    place("active", "alpha", "new alpha");
    writeFileSync(
      dir("cli-lock.json"),
      JSON.stringify({
        version: 1,
        skills: { alpha: { source: "new/repo" }, beta: { source: "new/repo" } },
      })
    );

    expect(rollbackReplacement(handle)).toBe("");

    expect(body("active", "alpha")).toBe("old alpha");
    expect(body("archive", "beta")).toBe("old beta");
    expect(linked("alpha")).toBe(true);
    expect(readJsonFile(dir("skills.lock.json")).external).toEqual(
      JSON.parse(LOCK).external
    );
    expect(readJsonFile(dir("cli-lock.json")).skills).toEqual({
      alpha: { source: "old/repo" },
    });
    expect(existsSync(handle.dir)).toBe(false);
  });

  test("置き換え対象以外の lock の変更は消さない", () => {
    place("active", "alpha", "old alpha");
    const handle = setAsideForReplacement(["alpha"]);
    const lock = readJsonFile(dir("skills.lock.json"));
    lock.external.gamma = {
      source: "else/repo",
      sourceUrl: "x",
      skillPath: "g",
    };
    writeFileSync(dir("skills.lock.json"), JSON.stringify(lock));
    const cli = readJsonFile(dir("cli-lock.json"));
    cli.skills.gamma = { source: "else/repo" };
    writeFileSync(dir("cli-lock.json"), JSON.stringify(cli));

    rollbackReplacement(handle);

    expect(
      Object.keys(readJsonFile(dir("skills.lock.json")).external).sort()
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(Object.keys(readJsonFile(dir("cli-lock.json")).skills)).toEqual([
      "alpha",
      "gamma",
    ]);
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
    commitReplacement(handle);

    finishReplacement(handle);

    expect(body("active", "alpha")).toBe("new alpha");
    expect(linked("alpha")).toBe(true);
    expect(body("active", "beta")).toBeNull();
    expect(body("archive", "beta")).toBe("new beta");
    expect(linked("beta")).toBe(false);
    const cli = readJsonFile(dir("cli-lock.json"));
    expect(Object.keys(cli.skills)).toEqual(["alpha"]);
    const stash = readJsonFile(dir("archive", ".cli-lock-stash.json"));
    expect(stash.beta).toEqual({ source: "new/repo" });
    expect(existsSync(handle.dir)).toBe(false);
  });
});

describe("recoverPendingReplacements", () => {
  test("commit 前に止まった置き換えは巻き戻す", () => {
    place("active", "alpha", "old alpha");
    const handle = setAsideForReplacement(["alpha"]);
    place("active", "alpha", "half-installed alpha");

    expect(recoverPendingReplacements()).toBe("");

    expect(body("active", "alpha")).toBe("old alpha");
    expect(linked("alpha")).toBe(true);
    expect(readJsonFile(dir("skills.lock.json")).external.alpha).toEqual({
      source: "old/repo",
      sourceUrl: "x",
      skillPath: "a",
    });
    expect(existsSync(handle.dir)).toBe(false);
  });

  test("退避の途中で止まっていても、まだ動かしていない既存は捨てない", () => {
    place("active", "alpha", "old alpha");
    place("archive", "beta", "old beta");
    const handle = setAsideForReplacement(["alpha", "beta"]);
    // beta を退避する前に落ちた状態を作る。
    renameSync(join(handle.dir, "beta"), dir("archive", "beta"));

    recoverPendingReplacements();

    expect(body("active", "alpha")).toBe("old alpha");
    expect(body("archive", "beta")).toBe("old beta");
  });

  test("commit 後に止まった置き換えは後始末を続ける", () => {
    place("archive", "beta", "old beta");
    const handle = setAsideForReplacement(["beta"]);
    place("active", "beta", "new beta");
    commitReplacement(handle);

    recoverPendingReplacements();

    expect(body("active", "beta")).toBeNull();
    expect(body("archive", "beta")).toBe("new beta");
    expect(existsSync(handle.dir)).toBe(false);
  });

  test("戻し先が埋まっていれば上書きせず、退避分を残して警告する", () => {
    place("archive", "beta", "old beta");
    const handle = setAsideForReplacement(["beta"]);
    place("archive", "beta", "someone else");

    expect(recoverPendingReplacements()).toContain("beta");

    expect(body("archive", "beta")).toBe("someone else");
    expect(readFileSync(join(handle.dir, "beta", "SKILL.md"), "utf8")).toBe(
      "old beta"
    );
  });
});

describe("replaceWhileInstalling", () => {
  test("install が済めば commit して後始末まで進める", async () => {
    place("archive", "beta", "old beta");

    const [result, warning] = await replaceWhileInstalling(
      ["beta"],
      async () => {
        place("active", "beta", "new beta");
        return 1;
      }
    );

    expect([result, warning]).toEqual([1, ""]);
    expect(body("archive", "beta")).toBe("new beta");
    expect(existsSync(dir("archive", ".replace"))).toBe(true);
    expect(readdirSync(dir("archive", ".replace"))).toEqual([]);
  });

  test("install が投げたら巻き戻してから同じエラーを投げ直す", async () => {
    place("active", "alpha", "old alpha");

    await expect(
      replaceWhileInstalling(["alpha"], async () => {
        place("active", "alpha", "half alpha");
        throw new Error("install failed");
      })
    ).rejects.toThrow("install failed");

    expect(body("active", "alpha")).toBe("old alpha");
    expect(linked("alpha")).toBe(true);
    expect(readdirSync(dir("archive", ".replace"))).toEqual([]);
  });
});

describe("installExternalSelection", () => {
  test("Off の既存は install せず、lock の取得元だけ付け替える", async () => {
    const marker = dir("install-ran");
    writeFileSync(dir("add-stub"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(dir("add-stub"), 0o755);
    setEnv("MY_SKILLS_ADD_SCRIPT", dir("add-stub"));
    setEnv("MY_SKILLS_IGNORE_FILE", dir("ignore.json"));
    const candidate = { name: "beta", path: "skills/beta/SKILL.md" };

    const [unignored, warning] = await installExternalSelection("new/repo", [
      {
        candidate,
        upstreamName: "beta",
        deployName: "beta",
        conflict: "Skill name already used by old/repo: beta",
        replaces: { source: "old/repo" },
      },
    ]);

    expect([unignored, warning]).toEqual([0, ""]);
    expect(existsSync(marker)).toBe(false);
    const lock = readJsonFile(dir("skills.lock.json"));
    expect(lock.external.beta).toEqual({
      source: "new/repo",
      sourceUrl: "https://github.com/new/repo.git",
      skillPath: "skills/beta/SKILL.md",
    });
    expect(lock.external.alpha.source).toBe("old/repo");
    expect(body("active", "beta")).toBeNull();
  });
});
