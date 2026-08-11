/**
 * サンドボックス契約の検証。
 *
 * #67 で最初に通すテスト。ここが通らないうちは他の移植に進まない。以降の全テストは
 * 「環境変数を渡せば実際のホームには触れない」という前提の上に乗っており、その前提が
 * TypeScript 側で崩れていると、テストが開発者本人の `~/.agents` や `~/.claude` を
 * 破壊しうる。
 *
 * 差し替えの確認だけでは不十分で、既定値がちゃんとホーム側を指していることも見る。
 * 全部がサンドボックスに固定されているせいで通っている、という偽陽性を潰すため。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import * as config from "./config";

/** 対象の環境変数と、それを読む関数の対応。増えたらここに足す。 */
const SANDBOX_VARS = [
  ["MY_SKILLS_LOCK_FILE", config.lockFile],
  ["MY_SKILLS_IGNORE_FILE", config.ignoreFile],
  ["MY_SKILLS_GLOBAL_LOCK_FILE", config.globalLockFile],
  ["MY_SKILLS_ACTIVE_DIR", config.activeDir],
  ["MY_SKILLS_ARCHIVE_DIR", config.archiveDir],
  ["MY_SKILLS_CLAUDE_SKILLS_DIR", config.claudeSkillsDir],
  ["MY_SKILLS_GEMINI_SKILLS_DIR", config.geminiSkillsDir],
  ["MY_SKILLS_PRESETS_DIR", config.presetsDir],
  ["MY_SKILLS_PROJECT_DECKS_DIR", config.projectDecksDir],
] as const;

const touched: string[] = [];

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.length = 0;
});

describe("サンドボックス差し替え", () => {
  test("全ての差し替え可能なパスが環境変数に従う", () => {
    for (const [name, read] of SANDBOX_VARS) {
      setEnv(name, `/tmp/sandbox/${name}`);
      expect(read()).toBe(`/tmp/sandbox/${name}`);
    }
  });

  test("差し替えないとホーム配下を指す（テストが偽陽性でないことの確認）", () => {
    for (const [name] of SANDBOX_VARS) delete process.env[name];

    const home = homedir();
    expect(config.activeDir()).toBe(join(home, ".agents", "skills"));
    expect(config.archiveDir()).toBe(join(home, ".agents", "skills-archive"));
    expect(config.claudeSkillsDir()).toBe(join(home, ".claude", "skills"));
    expect(config.geminiSkillsDir()).toBe(
      join(home, ".gemini", "config", "skills")
    );
    expect(config.presetsDir()).toBe(join(home, ".agents", "skill-presets"));
    expect(config.globalLockFile()).toBe(
      join(home, ".agents", ".skill-lock.json")
    );
  });

  test("空文字は未設定として扱う", () => {
    // 空文字を尊重すると相対パス解決に落ちて、意図しない場所を触りうる。
    setEnv("MY_SKILLS_ACTIVE_DIR", "");
    expect(config.activeDir()).toBe(join(homedir(), ".agents", "skills"));
  });

  test("リポジトリ相対の既定値がリポジトリ内を指す", () => {
    for (const [name] of SANDBOX_VARS) delete process.env[name];

    expect(config.lockFile()).toBe(join(config.REPO_ROOT, "skills.lock.json"));
    expect(config.ignoreFile()).toBe(
      join(config.REPO_ROOT, ".skills-ignore.json")
    );
    expect(config.projectDecksDir()).toBe(
      join(config.REPO_ROOT, "project-decks")
    );
  });

  test("REPO_ROOT が Engine checkout を指している", () => {
    expect(Bun.file(join(config.REPO_ROOT, "skill-loom")).size).toBeGreaterThan(
      0
    );
    expect(Bun.file(join(config.REPO_ROOT, "my-skills")).size).toBeGreaterThan(
      0
    );
  });
});
