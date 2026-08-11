/**
 * tristate 差分計算のテスト。
 *
 * ここを間違えると Apply が「触るべきでないものを触る」か「触るべきものを飛ばす」。
 * 特に「変化のない状態はスキップする」は、これが崩れると毎回全 skill を move し直す。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lock, Selection } from "./inventory";
import {
  computeTristateApplyDelta,
  formatTristateApplySummary,
  parseTristateStates,
} from "./tristate";

let sandbox: string;
const touched: string[] = [];

const lock: Lock = {
  custom: {
    repo: "owner/catalog",
    skills: { alpha: { repoPath: "skills/a/alpha" } },
  },
  external: { ext: { source: "owner/repo" } },
};

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

/** active / archive に実体ディレクトリを置く。 */
function place(where: "active" | "archive", ...names: string[]): void {
  for (const name of names)
    mkdirSync(join(sandbox, where, name), { recursive: true });
}

function delta(states: Record<string, Selection>) {
  const result = computeTristateApplyDelta(states, lock);
  return {
    extra: [...result.extra].sort(),
    restore: [...result.restore].sort(),
    install: [...result.install].sort(),
    remove: [...result.remove].sort(),
    unresolved: [...result.unresolved].sort(),
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-tristate-"));
  mkdirSync(join(sandbox, "active"), { recursive: true });
  mkdirSync(join(sandbox, "archive"), { recursive: true });
  setEnv("MY_SKILLS_ACTIVE_DIR", join(sandbox, "active"));
  setEnv("MY_SKILLS_ARCHIVE_DIR", join(sandbox, "archive"));
  setEnv("MY_SKILLS_IGNORE_FILE", join(sandbox, "ignore.json"));
});

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.length = 0;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("parseTristateStates", () => {
  test("tristate として妥当な値だけ拾う", () => {
    const states = parseTristateStates({
      states: { a: "active", b: "off", c: "archive", d: "bogus", e: 1 },
    });
    expect(states).toEqual({ a: "active", b: "off", c: "archive" });
  });

  test("states が無い・配列・null なら空", () => {
    expect(parseTristateStates({})).toEqual({});
    expect(parseTristateStates({ states: ["active"] })).toEqual({});
    expect(parseTristateStates(null)).toEqual({});
  });
});

describe("computeTristateApplyDelta", () => {
  test("現状と同じ指定は何も生まない", () => {
    place("active", "alpha");
    place("archive", "ext");

    expect(delta({ alpha: "active", ext: "archive" })).toEqual({
      extra: [],
      restore: [],
      install: [],
      remove: [],
      unresolved: [],
    });
  });

  test("active を off にすると remove", () => {
    place("active", "alpha");
    expect(delta({ alpha: "off" }).remove).toEqual(["alpha"]);
  });

  test("archive を off にしても remove（実体は archive 側にある）", () => {
    place("archive", "alpha");
    expect(delta({ alpha: "off" }).remove).toEqual(["alpha"]);
  });

  test("archive から active は restore で、install ではない", () => {
    place("archive", "alpha");
    const result = delta({ alpha: "active" });
    expect(result.restore).toEqual(["alpha"]);
    expect(result.install).toEqual([]);
  });

  test("未 install の管理下 skill を active にすると install", () => {
    expect(delta({ alpha: "active" }).install).toEqual(["alpha"]);
  });

  test("未 install の管理下 skill を archive にすると install してから archive へ移す", () => {
    const result = delta({ alpha: "archive" });
    expect(result.install).toEqual(["alpha"]);
    expect(result.extra).toEqual(["alpha"]);
  });

  test("active を archive にすると extra", () => {
    place("active", "alpha");
    expect(delta({ alpha: "archive" })).toMatchObject({
      extra: ["alpha"],
      install: [],
    });
  });

  test("どこにも居ない未知の skill は unresolved", () => {
    expect(delta({ nobody: "active" }).unresolved).toEqual(["nobody"]);
  });

  test("off 指定の未知 skill は unresolved にならない（消すものが無いだけ）", () => {
    expect(delta({ nobody: "off" })).toEqual({
      extra: [],
      restore: [],
      install: [],
      remove: [],
      unresolved: [],
    });
  });
});

describe("formatTristateApplySummary", () => {
  const s = (...names: string[]) => new Set(names);

  test("何も無ければ変更なし", () => {
    expect(formatTristateApplySummary(s(), s(), s(), s())).toBe(
      "変更はありません"
    );
  });

  test("件数は skill の重複を除いて数える", () => {
    // install してすぐ archive に入れた skill は 1 件。
    expect(formatTristateApplySummary(s("a"), s(), s("a"), s())).toBe(
      "Applied (1 skill): 新規追加 1: a; archive 1: a"
    );
  });

  test("並び順は 復帰・新規追加・archive・off", () => {
    expect(formatTristateApplySummary(s("d"), s("a"), s("b"), s("c"))).toBe(
      "Applied (4 skill): 復帰 1: a; 新規追加 1: b; archive 1: d; off(除去) 1: c"
    );
  });
});
