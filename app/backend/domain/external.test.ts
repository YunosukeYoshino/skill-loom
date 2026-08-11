/**
 * 外部 source の集計と更新確認のテスト。
 *
 * 更新確認は `MY_SKILLS_EXTERNAL_CANDIDATES_FILE` を差し込んでネットワークへ出ないようにする。
 * この経路を通ると内容ハッシュ比較だけになるので、active 以外を確認対象から外す判断や
 * source 単位の確認失敗の畳み方をそのまま検証できる。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeExternalSkillNames,
  addExternalToLock,
  collectExternalUpdateStatus,
  collectUpdatableSkillNames,
  externalRemoveCommand,
  externalSourceStatusLabel,
  externalSourceSummary,
  externalUpdateCommand,
  formatExternalUpdateMessage,
  installedExternalUpdateTasks,
  isArgvSafeSkillName,
  registerInstalledExternalSelection,
  removeExternalSkillFromManagement,
} from "./external";
import { externalSourceDetailPayload } from "../payloads";
import { sha256 } from "../infrastructure/github";
import type { Lock } from "./inventory";

let sandbox: string;
const touched: string[] = [];

const dir = (...parts: string[]) => join(sandbox, ...parts);

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

/** alpha と beta が同じ repo、gamma は別 repo。並べ替えの検証に使う。 */
const lock: Lock = {
  external: {
    gamma: {
      source: "Owner-Two/repo-two",
      sourceUrl: "https://github.com/Owner-Two/repo-two.git",
    },
    beta: {
      source: "owner-one/repo-one",
      sourceUrl: "https://github.com/owner-one/repo-one.git",
      skillPath: "skills/beta/SKILL.md",
    },
    alpha: {
      source: "owner-one/repo-one",
      sourceUrl: "https://github.com/owner-one/repo-one.git",
      skillPath: "skills/alpha/SKILL.md",
    },
  },
};

function place(where: "active" | "archive", name: string, body: string): void {
  mkdirSync(dir(where, name), { recursive: true });
  writeFileSync(dir(where, name, "SKILL.md"), body);
}

/** 候補一覧の fixture を書いて、以降の更新確認をそれに向ける。 */
function useCandidates(
  candidates: { name: string; path?: string; contentHash?: string }[]
): void {
  const path = dir("candidates.json");
  writeFileSync(path, JSON.stringify(candidates));
  setEnv("MY_SKILLS_EXTERNAL_CANDIDATES_FILE", path);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-external-"));
  for (const sub of ["active", "archive", "decks"])
    mkdirSync(dir(sub), { recursive: true });
  setEnv("MY_SKILLS_ACTIVE_DIR", dir("active"));
  setEnv("MY_SKILLS_ARCHIVE_DIR", dir("archive"));
  setEnv("MY_SKILLS_IGNORE_FILE", dir("ignore.json"));
  // 実在する CLI lock を読みに行かせない。読むと更新判定が GitHub へ出る。
  setEnv("MY_SKILLS_GLOBAL_LOCK_FILE", dir("skill-lock.json"));
});

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.length = 0;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("externalSourceSummary", () => {
  test("同じ repo は 1 行にまとまり、source は小文字比較で並ぶ", () => {
    expect(externalSourceSummary(lock)).toEqual([
      {
        source: "owner-one/repo-one",
        owner: "owner-one",
        repo: "repo-one",
        sourceUrl: "https://github.com/owner-one/repo-one.git",
        skills: ["alpha", "beta"],
      },
      {
        source: "Owner-Two/repo-two",
        owner: "Owner-Two",
        repo: "repo-two",
        sourceUrl: "https://github.com/Owner-Two/repo-two.git",
        skills: ["gamma"],
      },
    ]);
  });

  test("source が owner/repo の形でなければ owner と repo の両方に入る", () => {
    const [row] = externalSourceSummary({ external: { solo: {} } });
    expect(row).toMatchObject({
      source: "external",
      owner: "external",
      repo: "external",
    });
  });
});

describe("externalSourceStatusLabel", () => {
  test("未確認は空文字。確認前にバッジを出さない", () => {
    expect(externalSourceStatusLabel(undefined)).toBe("");
    expect(externalSourceStatusLabel({})).toBe("");
  });

  test("確認失敗・更新あり・最新を出し分ける", () => {
    expect(externalSourceStatusLabel({ checked: false })).toBe("確認失敗");
    expect(externalSourceStatusLabel({ checked: true, error: "boom" })).toBe(
      "確認失敗"
    );
    expect(
      externalSourceStatusLabel({ checked: true, updatable: ["alpha", "beta"] })
    ).toBe("更新あり 2");
    expect(externalSourceStatusLabel({ checked: true, updatable: [] })).toBe(
      "最新"
    );
  });
});

describe("activeExternalSkillNames / installedExternalUpdateTasks", () => {
  test("archive の skill は active ではないので確認対象に入らない", () => {
    place("active", "alpha", "local alpha\n");
    place("archive", "beta", "local beta\n");

    expect([...activeExternalSkillNames(lock)]).toEqual(["alpha"]);
    expect(installedExternalUpdateTasks(lock)).toEqual([
      ["owner-one/repo-one", "alpha", "skills/alpha/SKILL.md"],
    ]);
  });

  test("skillPath が無い skill は確認しようがないので落とす", () => {
    place("active", "gamma", "local gamma\n");
    expect(installedExternalUpdateTasks(lock)).toEqual([]);
  });

  test("source を絞れる。URL 形式で渡しても正規化されて一致する", () => {
    place("active", "alpha", "local alpha\n");
    place("active", "beta", "local beta\n");

    expect(
      installedExternalUpdateTasks(
        lock,
        "https://github.com/owner-one/repo-one"
      ).map(([, name]) => name)
    ).toEqual(["beta", "alpha"]);
    expect(installedExternalUpdateTasks(lock, "Owner-Two/repo-two")).toEqual(
      []
    );
  });
});

describe("collectExternalUpdateStatus", () => {
  test("内容ハッシュが違う active な skill だけ updatable に出る", async () => {
    place("active", "alpha", "local alpha\n");
    place("active", "beta", "local beta\n");
    useCandidates([
      {
        name: "alpha",
        path: "skills/alpha/SKILL.md",
        contentHash: sha256(Buffer.from("remote alpha\n")),
      },
      {
        name: "beta",
        path: "skills/beta/SKILL.md",
        contentHash: sha256(Buffer.from("local beta\n")),
      },
    ]);

    const [statusBySource, errors] = await collectExternalUpdateStatus(lock);
    expect(errors).toEqual([]);
    expect(statusBySource["owner-one/repo-one"]).toEqual({
      checked: true,
      updatable: ["alpha"],
    });
    // gamma は active ではないので、source ごと「最新」で確定する。
    expect(statusBySource["Owner-Two/repo-two"]).toEqual({
      checked: true,
      updatable: [],
    });
  });

  test("archive の skill は更新対象にしない", async () => {
    place("archive", "alpha", "local alpha\n");
    useCandidates([
      {
        name: "alpha",
        path: "skills/alpha/SKILL.md",
        contentHash: sha256(Buffer.from("remote\n")),
      },
    ]);

    const [statusBySource] = await collectExternalUpdateStatus(lock);
    expect(statusBySource["owner-one/repo-one"]?.updatable).toEqual([]);
  });

  test("候補側にハッシュが無ければ更新なしに倒す（押せないボタンを出さない）", async () => {
    place("active", "alpha", "local alpha\n");
    useCandidates([{ name: "alpha", path: "skills/alpha/SKILL.md" }]);

    const [statusBySource] = await collectExternalUpdateStatus(lock);
    expect(statusBySource["owner-one/repo-one"]?.updatable).toEqual([]);
  });

  test("候補取得に失敗した source は checked=false になり、errors にも出る", async () => {
    place("active", "alpha", "local alpha\n");
    setEnv("MY_SKILLS_EXTERNAL_CANDIDATES_FILE", dir("missing.json"));

    const [statusBySource, errors] = await collectExternalUpdateStatus(lock);
    expect(statusBySource["owner-one/repo-one"]?.checked).toBe(false);
    expect(statusBySource["owner-one/repo-one"]?.error).toBeTruthy();
    expect(errors).toHaveLength(2);
  });
});

describe("collectUpdatableSkillNames", () => {
  test("source を跨いで重複なく並ぶ", async () => {
    place("active", "alpha", "local alpha\n");
    place("active", "beta", "local beta\n");
    useCandidates([
      {
        name: "alpha",
        path: "skills/alpha/SKILL.md",
        contentHash: sha256(Buffer.from("remote alpha\n")),
      },
      {
        name: "beta",
        path: "skills/beta/SKILL.md",
        contentHash: sha256(Buffer.from("remote beta\n")),
      },
    ]);

    expect(await collectUpdatableSkillNames(lock)).toEqual([
      ["alpha", "beta"],
      [],
    ]);
  });

  test("source を絞ると他の source は確認しない", async () => {
    place("active", "alpha", "local alpha\n");
    useCandidates([
      {
        name: "alpha",
        path: "skills/alpha/SKILL.md",
        contentHash: sha256(Buffer.from("remote\n")),
      },
    ]);

    expect(
      await collectUpdatableSkillNames(lock, "Owner-Two/repo-two")
    ).toEqual([[], []]);
  });
});

describe("外部 CLI のコマンド", () => {
  test("update / remove は -g -y 付きで global に効かせる", () => {
    setEnv("MY_SKILLS_UPDATE_BIN", "/tmp/update-stub");
    setEnv("MY_SKILLS_REMOVE_BIN", "/tmp/remove-stub");

    expect(externalUpdateCommand("alpha")).toEqual([
      "/tmp/update-stub",
      "skills",
      "update",
      "alpha",
      "-g",
      "-y",
    ]);
    expect(externalRemoveCommand("alpha")).toEqual([
      "/tmp/remove-stub",
      "skills",
      "remove",
      "alpha",
      "-g",
      "-y",
    ]);
  });

  test("`-` 始まりは argv 上でフラグになるので skill 名として通さない", () => {
    // remove だけはリクエストの文字列がそのまま argv に乗る。ここを通すと
    // `skills remove --force -g -y` のように、消す対象がずれた命令になる。
    expect(isArgvSafeSkillName("alpha")).toBe(true);
    expect(isArgvSafeSkillName("my-skill-2")).toBe(true);
    expect(isArgvSafeSkillName("")).toBe(false);
    expect(isArgvSafeSkillName("-g")).toBe(false);
    expect(isArgvSafeSkillName("--all")).toBe(false);
  });
});

describe("formatExternalUpdateMessage", () => {
  test("何も無ければ update完了。区分は ` / ` で連結する", () => {
    expect(formatExternalUpdateMessage([], [], [])).toBe("update完了");
    expect(formatExternalUpdateMessage(["a"], ["b"], ["c"], ["x: boom"])).toBe(
      "updated: a / 未反映(CLI最新扱い): b / failed: c / 確認失敗: x: boom"
    );
  });

  test("確認失敗は 3 件までしか並べない", () => {
    expect(formatExternalUpdateMessage([], [], [], ["1", "2", "3", "4"])).toBe(
      "確認失敗: 1; 2; 3"
    );
  });
});

describe("removeExternalSkillFromManagement", () => {
  test("lock からも project deck からも落とし、書き換えた deck の数を返す", () => {
    const decks = dir("decks");
    writeFileSync(
      join(decks, "api.json"),
      JSON.stringify({ skills: ["alpha", "beta"] })
    );
    writeFileSync(
      join(decks, "backend.json"),
      JSON.stringify({ skills: ["gamma"] })
    );
    mkdirSync(join(decks, "nested"), { recursive: true });
    writeFileSync(
      join(decks, "nested", "web.json"),
      JSON.stringify({ skills: ["alpha"] })
    );

    const target: Lock = { external: { alpha: {}, beta: {} } };
    expect(removeExternalSkillFromManagement(target, "alpha", decks)).toBe(2);

    expect(Object.keys(target.external ?? {})).toEqual(["beta"]);
    expect(
      JSON.parse(readFileSync(join(decks, "api.json"), "utf-8")).skills
    ).toEqual(["beta"]);
    expect(
      JSON.parse(readFileSync(join(decks, "nested", "web.json"), "utf-8"))
        .skills
    ).toEqual([]);
    // 触っていない deck は書き換えない。
    expect(readFileSync(join(decks, "backend.json"), "utf-8")).toBe(
      '{"skills":["gamma"]}'
    );
  });

  test("deck ディレクトリが無くても落ちない", () => {
    const target: Lock = { external: { alpha: {} } };
    expect(
      removeExternalSkillFromManagement(target, "alpha", dir("no-such-dir"))
    ).toBe(0);
    expect(target.external).toEqual({});
  });
});

describe("addExternalToLock", () => {
  beforeEach(() => {
    setEnv("MY_SKILLS_LOCK_FILE", dir("skills.lock.json"));
    writeFileSync(
      dir("skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: {
          repo: "owner/catalog",
          skills: { mine: { repoPath: "skills/test/mine", category: "test" } },
        },
        external: {},
        vendor: {},
      })
    );
  });

  const candidates = [
    { name: "alpha", path: "packs/alpha/SKILL.md", description: "" },
    { name: "bare", description: "" },
  ];

  test("source を正規化して lock に載せる", () => {
    addExternalToLock(
      "https://github.com/Owner/Repo",
      new Set(["alpha"]),
      candidates
    );

    expect(
      JSON.parse(readFileSync(dir("skills.lock.json"), "utf-8")).external
    ).toEqual({
      alpha: {
        source: "Owner/Repo",
        sourceUrl: "https://github.com/Owner/Repo.git",
        skillPath: "packs/alpha/SKILL.md",
      },
    });
  });

  test("path の無い候補は既定の置き場所で埋める", () => {
    addExternalToLock("owner/repo", new Set(["bare"]), candidates);

    expect(
      JSON.parse(readFileSync(dir("skills.lock.json"), "utf-8")).external.bare
        .skillPath
    ).toBe("skills/bare/SKILL.md");
  });

  test("custom skill と同名なら external には足さない", () => {
    addExternalToLock("owner/repo", new Set(["mine"]), [
      { name: "mine", description: "" },
    ]);

    expect(
      JSON.parse(readFileSync(dir("skills.lock.json"), "utf-8")).external
    ).toEqual({});
  });

  test("source に無い名前は弾く", () => {
    // 通してしまうと、その deck を install した時点で必ず unresolved で止まる。
    expect(() =>
      addExternalToLock("owner/repo", new Set(["nope"]), candidates)
    ).toThrow("Skill not found in source: nope");
  });

  test("取り込んだ skill は ignore から外す", () => {
    writeFileSync(
      dir("ignore.json"),
      JSON.stringify({ ignore: ["alpha", "other"] })
    );
    addExternalToLock("owner/repo", new Set(["alpha"]), candidates);

    expect(
      JSON.parse(readFileSync(dir("ignore.json"), "utf-8")).ignore
    ).toEqual(["other"]);
  });
});

describe("registerInstalledExternalSelection", () => {
  beforeEach(() => {
    setEnv("MY_SKILLS_LOCK_FILE", dir("skills.lock.json"));
    writeFileSync(
      dir("skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        external: {},
        vendor: {},
      })
    );
  });

  test("CLI lock に取得元が残っていればそちらを写す", () => {
    writeFileSync(
      dir("skill-lock.json"),
      JSON.stringify({
        skills: {
          alpha: {
            sourceUrl: "https://example.com/mirror.git",
            skillPath: "deep/alpha/SKILL.md",
          },
        },
      })
    );

    const [updated, unignored] = registerInstalledExternalSelection(
      "owner/repo",
      new Set(["alpha", "beta"])
    );

    expect(unignored).toBe(0);
    expect(updated.external).toEqual({
      alpha: {
        source: "owner/repo",
        sourceUrl: "https://example.com/mirror.git",
        skillPath: "deep/alpha/SKILL.md",
      },
      // CLI lock に無い分は source から組み立てた既定値へ倒す。
      beta: {
        source: "owner/repo",
        sourceUrl: "https://github.com/owner/repo.git",
        skillPath: "skills/beta/SKILL.md",
      },
    });
  });

  test("ignore を外した件数を返す", () => {
    writeFileSync(
      dir("ignore.json"),
      JSON.stringify({ ignore: ["alpha", "beta", "other"] })
    );

    expect(
      registerInstalledExternalSelection(
        "owner/repo",
        new Set(["alpha", "beta"])
      )[1]
    ).toBe(2);
    expect(
      JSON.parse(readFileSync(dir("ignore.json"), "utf-8")).ignore
    ).toEqual(["other"]);
  });
});

describe("externalSourceDetailPayload", () => {
  beforeEach(() => {
    // deckNames() が本物の project-decks を読まないよう、存在しない場所へ向けて閉じる
    setEnv("MY_SKILLS_PROJECT_DECKS_DIR", dir("no-such-decks"));
  });

  test("最後の skill を外して管理対象が無くなった source は installed が空になる", async () => {
    const detail = await externalSourceDetailPayload(
      { external: {} },
      "owner-one/repo-one",
      []
    );
    expect(detail.installed).toEqual([]);
  });

  test("同じ source に管理対象が残っていれば installed に載り、連続で外せる状態を保つ", async () => {
    const detail = await externalSourceDetailPayload(
      {
        external: {
          alpha: {
            source: "owner-one/repo-one",
            skillPath: "skills/alpha/SKILL.md",
          },
          beta: {
            source: "owner-one/repo-one",
            skillPath: "skills/beta/SKILL.md",
          },
        },
      },
      "owner-one/repo-one",
      []
    );
    expect(detail.installed.map((skill) => skill.name)).toEqual([
      "alpha",
      "beta",
    ]);
  });
});
