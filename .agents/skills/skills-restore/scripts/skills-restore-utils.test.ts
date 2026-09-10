/**
 * skills-restore ユーティリティ（lock-repo / restore-lock）のパリティテスト。
 *
 * Python 版 lock-repo.py / restore-lock.py の CLI 契約（stdout・stderr・exit code）を
 * 保持していることを、Bun の test runner で検証する。期待値は既存の挙動から
 * 導出したリテラルを使う。
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_REPO = path.resolve(__dirname, "lock-repo.ts");
const RESTORE_LOCK = path.resolve(__dirname, "restore-lock.ts");

function run(
  script: string,
  ...args: string[]
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", script, ...args]);
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("lock-repo", () => {
  test("lock の custom.repo を stdout に出す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockrepo-"));
    const lockFile = path.join(dir, "skills.lock.json");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
      })
    );

    const out = run(LOCK_REPO, lockFile);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("owner/catalog");
  });
});

describe("restore-lock", () => {
  test("installSkill を npx filter に使う", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restorel-"));
    const lockFile = path.join(dir, "skills.lock.json");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        external: {
          "json-render": {
            source: "vercel-labs/json-render",
            installSkill: "react",
          },
          defuddle: { source: "kepano/obsidian-skills" },
        },
      })
    );

    const out = run(RESTORE_LOCK, lockFile);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(
      "npx skills add vercel-labs/json-render --skill react -g -a claude-code -a codex -a antigravity -y"
    );
    expect(out.stdout).toContain(
      "npx skills add kepano/obsidian-skills --skill defuddle -g -a claude-code -a codex -a antigravity -y"
    );
    expect(out.stdout).not.toContain("--skill json-render");
  });

  test("source が無い external をスキップして warning を stderr に出す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restoremiss-"));
    const lockFile = path.join(dir, "skills.lock.json");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        external: {
          broken: {},
          defuddle: { source: "kepano/obsidian-skills" },
        },
      })
    );

    const out = run(RESTORE_LOCK, lockFile);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("npx skills add kepano/obsidian-skills");
    expect(out.stdout).not.toContain("--skill broken");
    expect(out.stderr).toContain("missing source");
  });

  test("--install 時に installSkill が指定されたスキルをリネームし frontmatter を同期する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-install-"));
    const lockFile = path.join(dir, "skills.lock.json");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        external: {
          "owner--alpha": {
            source: "owner/repo",
            installSkill: "alpha",
          },
        },
      })
    );

    const home = path.join(dir, "home");
    const activeDir = path.join(home, ".agents", "skills");
    fs.mkdirSync(activeDir, { recursive: true });

    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    const npxStub = path.join(binDir, "npx");
    fs.writeFileSync(
      npxStub,
      `#!/usr/bin/env bash
mkdir -p "$HOME/.agents/skills/alpha"
printf -- "---\\nname: alpha\\ndescription: test\\n---\\n" > "$HOME/.agents/skills/alpha/SKILL.md"
`
    );
    fs.chmodSync(npxStub, 0o755);

    const env = {
      ...process.env,
      MISE_YES: "1",
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    const res = Bun.spawnSync(
      [process.execPath, RESTORE_LOCK, "--install", lockFile],
      {
        env,
      }
    );
    expect(res.exitCode).toBe(0);

    expect(fs.existsSync(path.join(activeDir, "alpha"))).toBe(false);
    const targetMd = path.join(activeDir, "owner--alpha", "SKILL.md");
    expect(fs.existsSync(targetMd)).toBe(true);
    expect(fs.readFileSync(targetMd, "utf-8")).toContain("name: owner--alpha");
  });

  test("--install 時に既存の上流名ディレクトリを残す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-coexist-"));
    const lockFile = path.join(dir, "skills.lock.json");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        external: {
          "owner--alpha": {
            source: "owner/repo",
            installSkill: "alpha",
          },
        },
      })
    );

    const home = path.join(dir, "home");
    const activeDir = path.join(home, ".agents", "skills");
    fs.mkdirSync(path.join(activeDir, "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(activeDir, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: original\n---\n"
    );

    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    const npxStub = path.join(binDir, "npx");
    fs.writeFileSync(
      npxStub,
      `#!/usr/bin/env bash
mkdir -p "$HOME/.agents/skills/alpha"
printf -- "---\\nname: alpha\\ndescription: incoming\\n---\\n" > "$HOME/.agents/skills/alpha/SKILL.md"
`
    );
    fs.chmodSync(npxStub, 0o755);

    const res = Bun.spawnSync(
      [process.execPath, RESTORE_LOCK, "--install", lockFile],
      {
        env: {
          ...process.env,
          MISE_YES: "1",
          HOME: home,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      }
    );
    expect(res.exitCode).toBe(0);
    expect(
      fs.readFileSync(path.join(activeDir, "alpha", "SKILL.md"), "utf-8")
    ).toContain("description: original");
    expect(
      fs.readFileSync(path.join(activeDir, "owner--alpha", "SKILL.md"), "utf-8")
    ).toContain("name: owner--alpha");
  });
});

describe("PR 6 restore regressions", () => {
  test.each([false, true])(
    "restore keeps canonical skills and agent links (preexisting=%s)",
    (preexisting) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "restore-regression-")
      );
      const home = path.join(root, "home");
      const active = path.join(home, ".agents/skills");
      const claude = path.join(home, ".claude/skills");
      const gemini = path.join(home, ".gemini/config/skills");
      const bin = path.join(root, "bin");
      for (const dir of [active, claude, gemini, bin])
        fs.mkdirSync(dir, { recursive: true });
      if (preexisting) {
        fs.mkdirSync(path.join(home, ".agents/original"));
        fs.symlinkSync("../original", path.join(active, "alpha"));
        fs.writeFileSync(
          path.join(active, "alpha/SKILL.md"),
          "---\nname: alpha\n---\noriginal\n"
        );
        for (const agent of [claude, gemini])
          fs.symlinkSync(path.join(active, "alpha"), path.join(agent, "alpha"));
      }
      const lockFile = path.join(root, "lock.json");
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          external: {
            ...(!preexisting ? { alpha: { source: "owner/repo" } } : {}),
            "owner--alpha": { source: "owner/repo", installSkill: "alpha" },
          },
        })
      );
      fs.writeFileSync(
        path.join(bin, "npx"),
        `#!/bin/bash
set -eu
mkdir -p "$HOME/.agents/skills/alpha"
printf -- '---\\nname: alpha\\n---\\nincoming\\n' > "$HOME/.agents/skills/alpha/SKILL.md"
for agent in "$HOME/.claude/skills" "$HOME/.gemini/config/skills"; do
  ln -sf "$HOME/.agents/skills/alpha" "$agent/alpha"
done
`
      );
      fs.chmodSync(path.join(bin, "npx"), 0o755);
      const result = Bun.spawnSync(
        [process.execPath, RESTORE_LOCK, "--install", lockFile],
        {
          env: {
            ...process.env,
            HOME: home,
            TMPDIR: path.join(root, "unavailable-tmp"),
            MY_SKILLS_ACTIVE_DIR: active,
            MY_SKILLS_CLAUDE_SKILLS_DIR: claude,
            MY_SKILLS_GEMINI_SKILLS_DIR: gemini,
            PATH: `${bin}:${process.env.PATH}`,
          },
        }
      );
      expect(result.exitCode).toBe(0);
      for (const name of ["alpha", "owner--alpha"]) {
        expect(fs.existsSync(path.join(active, name, "SKILL.md"))).toBe(true);
        for (const agent of [claude, gemini])
          expect(fs.existsSync(path.join(agent, name, "SKILL.md"))).toBe(true);
      }
      if (preexisting)
        expect(
          fs.readFileSync(path.join(active, "alpha/SKILL.md"), "utf8")
        ).toContain("original");
    }
  );
});
