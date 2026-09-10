/**
 * 外部 source の集計と更新確認のテスト。
 *
 * 更新確認は `MY_SKILLS_EXTERNAL_CANDIDATES_FILE` を差し込んでネットワークへ出ないようにする。
 * この経路を通ると内容ハッシュ比較だけになるので、active 以外を確認対象から外す判断や
 * source 単位の確認失敗の畳み方をそのまま検証できる。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
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
  resolveExternalCandidatesMapping,
  runExternalInstall,
  resolveSelectedExternalSkills,
  skillHasRemoteUpdate,
} from "./external";
import {
  externalPreviewPayload,
  externalSourceDetailPayload,
} from "../payloads";
import {
  discoverExternalSkillCandidates,
  sha256,
} from "../infrastructure/github";
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
      ["owner-one/repo-one", "alpha", "skills/alpha/SKILL.md", "alpha"],
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

  test("空白・command text を含む skill 名は HTTP remove guard を通さない", () => {
    for (const name of ["two skills", "alpha;echo pwned", "$(whoami)", "a'b"]) {
      expect(isArgvSafeSkillName(name)).toBe(false);
    }
  });

  test("update は空・option 形式の skill 名を argv に載せない", () => {
    for (const name of ["", "-g", "--all"]) {
      expect(() => externalUpdateCommand(name)).toThrow(
        `Invalid external skill name: ${name}`
      );
    }
  });

  test("remove は空白・command text を含む skill 名を argv に載せない", () => {
    for (const name of ["two skills", "alpha;echo pwned", "$(whoami)", "a'b"]) {
      expect(() => externalRemoveCommand(name)).toThrow(
        `Invalid external skill name: ${name}`
      );
    }
  });

  test("規約以前の緩い入力で登録された既有名も update / remove できる", () => {
    // lock には命名規約ができる前の名前が残り得る。argv として安全なら
    // 動かせなくして、利用者が更新・削除のどちらもできなくなることは避ける。
    expect(isArgvSafeSkillName("my_skill")).toBe(true);
    expect(isArgvSafeSkillName("skill.v2")).toBe(true);
    expect(externalUpdateCommand("my_skill")[3]).toBe("my_skill");
    expect(externalRemoveCommand("my_skill")[3]).toBe("my_skill");
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

  test("custom skill と同名なら名前空間化して登録する", () => {
    addExternalToLock("owner/repo", new Set(["mine"]), [
      { name: "mine", description: "" },
    ]);

    expect(
      JSON.parse(readFileSync(dir("skills.lock.json"), "utf-8")).external
    ).toEqual({
      "owner--mine": {
        source: "owner/repo",
        sourceUrl: "https://github.com/owner/repo.git",
        skillPath: "skills/mine/SKILL.md",
        installSkill: "mine",
      },
    });
  });

  test("source に無い名前は弾く", () => {
    // 通してしまうと、その deck を install した時点で必ず unresolved で止まる。
    expect(() =>
      addExternalToLock("owner/repo", new Set(["nope"]), candidates)
    ).toThrow("Skill not found in source: nope");
  });

  test("unsafe な候補名は lock へ永続化しない", () => {
    const unsafeName = "alpha;echo pwned";

    expect(() =>
      addExternalToLock("owner/repo", new Set([unsafeName]), [
        { name: unsafeName, description: "" },
      ])
    ).toThrow(`Invalid external skill name: ${unsafeName}`);
    expect(
      JSON.parse(readFileSync(dir("skills.lock.json"), "utf-8")).external
    ).toEqual({});
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

describe("runExternalInstall", () => {
  test("unsafe な skill 名は subprocess を起動する前に弾く", async () => {
    const marker = dir("install-ran");
    const script = dir("skills-add-stub");
    writeFileSync(script, `#!/bin/sh\nprintf touched > '${marker}'\n`);
    setEnv("MY_SKILLS_ADD_SCRIPT", script);

    await expect(
      runExternalInstall("owner/repo", new Set(["--all"]))
    ).rejects.toThrow("Invalid external skill name: --all");
    expect(existsSync(marker)).toBe(false);
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

  test("空白を含む skill 名は lock へ永続化しない", () => {
    const unsafeName = "two skills";

    expect(() =>
      registerInstalledExternalSelection("owner/repo", new Set([unsafeName]))
    ).toThrow(`Invalid external skill name: ${unsafeName}`);
    expect(
      JSON.parse(readFileSync(dir("skills.lock.json"), "utf-8")).external
    ).toEqual({});
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

  test("エイリアス登録したスキルは展開名で installed、上流名は available に出さない", async () => {
    place("active", "owner--alpha", "---\nname: owner--alpha\n---\n");
    const detail = await externalSourceDetailPayload(
      {
        external: {
          "owner--alpha": {
            source: "owner/repo",
            skillPath: "skills/alpha/SKILL.md",
            installSkill: "alpha",
          },
        },
      },
      "owner/repo",
      [
        {
          name: "alpha",
          path: "skills/alpha/SKILL.md",
          description: "Alpha skill",
        },
      ]
    );
    expect(detail.installed.map((skill) => skill.name)).toEqual([
      "owner--alpha",
    ]);
    expect(detail.available.map((skill) => skill.name)).toEqual([]);
  });

  test("表示する update command は shell に貼り付けても引数境界を保つ", async () => {
    place("active", "alpha", "local alpha\n");
    setEnv("MY_SKILLS_UPDATE_BIN", "/tmp/update stub;echo pwned");

    const detail = await externalSourceDetailPayload(
      {
        external: {
          alpha: {
            source: "owner/repo",
            skillPath: "skills/alpha/SKILL.md",
          },
        },
      },
      "owner/repo",
      [
        {
          name: "alpha",
          path: "skills/alpha/SKILL.md",
          contentHash: sha256(Buffer.from("remote alpha\n")),
        },
      ]
    );

    expect(detail.installed[0]?.updateCommand).toBe(
      "'/tmp/update stub;echo pwned' skills update alpha -g -y"
    );
  });
});

describe("resolveExternalCandidatesMapping", () => {
  test("衝突がない場合は upstreamName と deployName が同一", () => {
    const testLock: Lock = {
      external: {},
    };
    const candidates = [{ name: "alpha", path: "skills/alpha/SKILL.md" }];
    const mapping = resolveExternalCandidatesMapping(
      testLock,
      "owner/repo",
      candidates
    );
    expect(mapping).toEqual([
      {
        candidate: candidates[0]!,
        upstreamName: "alpha",
        deployName: "alpha",
        isColliding: false,
      },
    ]);
  });

  test("Custom スキルと名前が衝突する場合、owner--name に名前空間化される", () => {
    const testLock: Lock = {
      custom: {
        repo: "my/catalog",
        skills: { alpha: { repoPath: "custom/alpha" } },
      },
      external: {},
    };
    const candidates = [{ name: "alpha", path: "skills/alpha/SKILL.md" }];
    const mapping = resolveExternalCandidatesMapping(
      testLock,
      "other-owner/repo",
      candidates
    );
    expect(mapping).toEqual([
      {
        candidate: candidates[0]!,
        upstreamName: "alpha",
        deployName: "other-owner--alpha",
        isColliding: true,
      },
    ]);
  });

  test("別リポジトリの External スキルと衝突する場合、owner--name に名前空間化される", () => {
    const testLock: Lock = {
      external: {
        alpha: {
          source: "first-owner/repo",
          skillPath: "skills/alpha/SKILL.md",
        },
      },
    };
    const candidates = [{ name: "alpha", path: "skills/alpha/SKILL.md" }];
    const mapping = resolveExternalCandidatesMapping(
      testLock,
      "second-owner/repo",
      candidates
    );
    expect(mapping).toEqual([
      {
        candidate: candidates[0]!,
        upstreamName: "alpha",
        deployName: "second-owner--alpha",
        isColliding: true,
      },
    ]);
  });

  test("同一リポジトリの既存スキルとは衝突とみなさない", () => {
    const testLock: Lock = {
      external: {
        alpha: {
          source: "owner/repo",
          skillPath: "skills/alpha/SKILL.md",
        },
      },
    };
    const candidates = [{ name: "alpha", path: "skills/alpha/SKILL.md" }];
    const mapping = resolveExternalCandidatesMapping(
      testLock,
      "owner/repo",
      candidates
    );
    expect(mapping).toEqual([
      {
        candidate: candidates[0]!,
        upstreamName: "alpha",
        deployName: "alpha",
        isColliding: false,
      },
    ]);
  });

  test("Vendor スキルと名前が衝突する場合、owner--name に名前空間化される", () => {
    const testLock: Lock = {
      vendor: { alpha: { source: "other/repo" } },
      external: {},
    };
    const candidates = [{ name: "alpha", path: "skills/alpha/SKILL.md" }];
    const mapping = resolveExternalCandidatesMapping(
      testLock,
      "second-owner/repo",
      candidates
    );
    expect(mapping).toEqual([
      {
        candidate: candidates[0]!,
        upstreamName: "alpha",
        deployName: "second-owner--alpha",
        isColliding: true,
      },
    ]);
  });

  test("active にある同名スキルは衝突として名前空間化する", () => {
    place("active", "alpha", "---\nname: alpha\n---\n");
    const testLock: Lock = {
      external: {
        alpha: {
          source: "first-owner/repo",
          skillPath: "skills/alpha/SKILL.md",
        },
      },
    };
    const candidates = [{ name: "alpha", path: "skills/alpha/SKILL.md" }];
    const mapping = resolveExternalCandidatesMapping(
      testLock,
      "second-owner/repo",
      candidates
    );
    expect(mapping).toEqual([
      {
        candidate: candidates[0]!,
        upstreamName: "alpha",
        deployName: "second-owner--alpha",
        isColliding: true,
      },
    ]);
  });
});

describe("addExternalToLock with collision", () => {
  test("衝突時に名前空間化されたキーと installSkill を記録する", () => {
    const lockPath = dir("skills.lock.json");
    setEnv("MY_SKILLS_LOCK_FILE", lockPath);
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        custom: {
          repo: "owner/catalog",
          skills: { alpha: { category: "custom", repoPath: "custom/alpha" } },
        },
        external: {},
        vendor: {},
      })
    );

    const candidates = [{ name: "alpha", path: "skills/alpha/SKILL.md" }];

    addExternalToLock("other/repo", new Set(["other--alpha"]), candidates);

    const updated = JSON.parse(readFileSync(lockPath, "utf-8")) as Lock;
    expect(updated.external).toEqual({
      "other--alpha": {
        source: "other/repo",
        sourceUrl: "https://github.com/other/repo.git",
        skillPath: "skills/alpha/SKILL.md",
        installSkill: "alpha",
      },
    });
  });

  test("Vendor と衝突する場合も名前空間化して登録する", () => {
    const lockPath = dir("skills.lock.json");
    setEnv("MY_SKILLS_LOCK_FILE", lockPath);
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        external: {},
        vendor: { alpha: { source: "old/repo" } },
      })
    );

    addExternalToLock("other/repo", new Set(["alpha"]), [
      { name: "alpha", path: "skills/alpha/SKILL.md" },
    ]);

    const updated = JSON.parse(readFileSync(lockPath, "utf-8")) as Lock;
    expect(updated.external).toEqual({
      "other--alpha": {
        source: "other/repo",
        sourceUrl: "https://github.com/other/repo.git",
        skillPath: "skills/alpha/SKILL.md",
        installSkill: "alpha",
      },
    });
  });
});

describe("runExternalInstall with collision", () => {
  test("衝突時に --as オプション付きで skills-add を呼び出す", async () => {
    const logFile = dir("skills-add-args.log");
    const script = dir("skills-add-stub");
    writeFileSync(script, `#!/bin/sh\necho "$@" >> '${logFile}'\n`);
    chmodSync(script, 0o755);
    setEnv("MY_SKILLS_ADD_SCRIPT", script);

    const lockPath = dir("skills.lock.json");
    setEnv("MY_SKILLS_LOCK_FILE", lockPath);
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        custom: {
          repo: "owner/catalog",
          skills: { alpha: { category: "custom", repoPath: "custom/alpha" } },
        },
        external: {},
        vendor: {},
      })
    );
    useCandidates([
      { name: "alpha", path: "skills/alpha/SKILL.md" },
      { name: "beta", path: "skills/beta/SKILL.md" },
    ]);

    await runExternalInstall("other/repo", new Set(["other--alpha", "beta"]));

    const logContent = readFileSync(logFile, "utf-8");
    // beta は通常インストール
    expect(logContent).toContain("other/repo --no-commit --skill beta");
    // alpha は --as 付きで個別インストール
    expect(logContent).toContain(
      "other/repo --skill alpha --as other--alpha --no-commit"
    );
  });
});

describe("externalPreviewPayload with collision", () => {
  test("衝突するスキルの候補行が名前空間化される", () => {
    const testLock: Lock = {
      custom: {
        repo: "owner/catalog",
        skills: { alpha: { repoPath: "custom/alpha" } },
      },
      external: {},
    };
    const candidates = [
      {
        name: "alpha",
        path: "skills/alpha/SKILL.md",
        description: "Alpha skill",
      },
      { name: "beta", path: "skills/beta/SKILL.md", description: "Beta skill" },
    ];

    const payload = externalPreviewPayload(
      testLock,
      "",
      "other/repo",
      candidates
    );
    expect(payload.rows).toEqual([
      {
        name: "other--alpha",
        category: "[名前空間: other--alpha] skills/alpha/SKILL.md",
        description: "Alpha skill",
        source: "external",
        state: "missing",
        checked: false,
      },
      {
        name: "beta",
        category: "skills/beta/SKILL.md",
        description: "Beta skill",
        source: "external",
        state: "missing",
        checked: false,
      },
    ]);
  });
});

describe("PR 6 import regressions", () => {
  beforeEach(() => {
    setEnv("MY_SKILLS_LOCK_FILE", dir("skills.lock.json"));
    setEnv("MY_SKILLS_PROJECT_DECKS_DIR", dir("decks"));
    writeFileSync(
      dir("skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        vendor: {},
        external: {},
      })
    );
  });

  test("occupied namespace is rejected without rewriting the lock", () => {
    const data = {
      version: 1,
      custom: { repo: "owner/catalog", skills: {} },
      vendor: {},
      external: {
        alpha: {
          source: "first/repo",
          sourceUrl: "https://github.com/first/repo.git",
          skillPath: "skills/alpha/SKILL.md",
        },
        "owner--alpha": {
          source: "owner/other",
          sourceUrl: "https://github.com/owner/other.git",
          skillPath: "skills/alpha/SKILL.md",
        },
      },
    };
    writeFileSync(dir("skills.lock.json"), JSON.stringify(data));
    expect(() =>
      addExternalToLock("owner/repo", new Set(["alpha"]), [{ name: "alpha" }])
    ).toThrow("already exists");
    expect(JSON.parse(readFileSync(dir("skills.lock.json"), "utf8"))).toEqual(
      data
    );
  });

  test("an unmanaged namespace directory is not reused", () => {
    place("active", "owner--alpha", "local");
    expect(() =>
      resolveSelectedExternalSkills(
        { external: { alpha: { source: "first/repo" } } },
        "owner/repo",
        new Set(["alpha"]),
        [{ name: "alpha" }]
      )
    ).toThrow("already exists");
  });

  test("uppercase owner generates a lowercase deploy name", () => {
    expect(
      resolveExternalCandidatesMapping(
        { vendor: { alpha: {} } },
        "Owner/repo",
        [{ name: "alpha" }]
      )[0]?.deployName
    ).toBe("owner--alpha");
  });

  test.each(["add", "register"])(
    "%s keeps another skill ignored and does not copy its metadata",
    (action) => {
      const original = {
        source: "first/repo",
        sourceUrl: "https://github.com/first/repo.git",
        skillPath: "private/old/SKILL.md",
        installSkill: "old",
      };
      writeFileSync(
        dir("skills.lock.json"),
        JSON.stringify({
          version: 1,
          custom: { repo: "owner/catalog", skills: {} },
          vendor: {},
          external: { alpha: original },
        })
      );
      writeFileSync(
        dir("skill-lock.json"),
        JSON.stringify({ skills: { alpha: original } })
      );
      writeFileSync(
        dir("ignore.json"),
        JSON.stringify({ ignore: ["alpha", "owner--alpha"] })
      );
      const candidates = [{ name: "alpha", path: "packs/alpha/SKILL.md" }];
      if (action === "add")
        addExternalToLock("owner/repo", new Set(["owner--alpha"]), candidates);
      else
        registerInstalledExternalSelection(
          "owner/repo",
          new Set(["owner--alpha"]),
          resolveSelectedExternalSkills(
            { external: { alpha: original } },
            "owner/repo",
            new Set(["alpha"]),
            candidates
          )
        );
      expect(
        JSON.parse(readFileSync(dir("ignore.json"), "utf8")).ignore
      ).toEqual(["alpha"]);
      const updated = JSON.parse(readFileSync(dir("skills.lock.json"), "utf8"));
      expect(updated.external.alpha).toEqual(original);
      if (action === "add")
        expect(updated.external["owner--alpha"].installSkill).toBe("alpha");
    }
  );

  test("alias metadata belongs to its own source", () => {
    writeFileSync(
      dir("skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        vendor: {},
        external: {
          alpha: {
            source: "first/repo",
            sourceUrl: "https://github.com/first/repo.git",
            skillPath: "wrong/SKILL.md",
            installSkill: "wrong",
          },
        },
      })
    );
    const candidates = [{ name: "alpha", path: "packs/alpha/SKILL.md" }];
    const resolved = resolveSelectedExternalSkills(
      {
        external: {
          alpha: {
            source: "first/repo",
            sourceUrl: "https://github.com/first/repo.git",
            skillPath: "skills/alpha/SKILL.md",
          },
        },
      },
      "owner/repo",
      new Set(["alpha"]),
      candidates
    );
    const [updated] = registerInstalledExternalSelection(
      "owner/repo",
      new Set(["owner--alpha"]),
      resolved
    );
    expect(updated.external?.["owner--alpha"]).toEqual({
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "packs/alpha/SKILL.md",
      installSkill: "alpha",
    });
  });

  test("registration keeps the resolved name after installation changes active", () => {
    const candidates = [{ name: "alpha", path: "packs/alpha/SKILL.md" }];
    const resolved = resolveSelectedExternalSkills(
      {},
      "owner/repo",
      new Set(["alpha"]),
      candidates
    );
    place("active", "alpha", "---\nname: alpha\n---\n");
    const [updated] = registerInstalledExternalSelection(
      "owner/repo",
      new Set(["alpha"]),
      resolved
    );
    expect(Object.keys(updated.external ?? {})).toEqual(["alpha"]);
  });

  test("an alias named beta does not hide the upstream beta candidate", async () => {
    const detail = await externalSourceDetailPayload(
      { external: { beta: { source: "owner/repo", installSkill: "alpha" } } },
      "owner/repo",
      [{ name: "alpha" }, { name: "beta" }]
    );
    expect(detail.available.map((row) => row.name)).toEqual(["owner--beta"]);
    const selected = resolveSelectedExternalSkills(
      { external: { beta: { source: "owner/repo", installSkill: "alpha" } } },
      "owner/repo",
      new Set(detail.available.map((row) => row.name)),
      [{ name: "alpha" }, { name: "beta" }]
    );
    expect(selected.map((row) => row.upstreamName)).toEqual(["beta"]);
    expect(
      resolveExternalCandidatesMapping(
        { external: { beta: { source: "owner/repo", installSkill: "alpha" } } },
        "owner/repo",
        [{ name: "beta" }]
      )[0]?.deployName
    ).toBe("owner--beta");
  });

  test("a freshly renamed skill is current, but a body change is detected", async () => {
    const upstream = dir("upstream", "alpha");
    mkdirSync(upstream, { recursive: true });
    writeFileSync(
      join(upstream, "SKILL.md"),
      '---\nname: "alpha"\ndescription: fixture\n---\nbody\n'
    );
    const [candidate] = discoverExternalSkillCandidates(dir("upstream"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("missing candidate");
    place(
      "active",
      "owner--alpha",
      "---\nname: owner--alpha\ndescription: fixture\n---\nbody\n"
    );
    expect(await skillHasRemoteUpdate("owner--alpha", candidate, "alpha")).toBe(
      false
    );
    place(
      "active",
      "owner--alpha",
      "---\nname: owner--alpha\ndescription: fixture\n---\nchanged body\n"
    );
    expect(await skillHasRemoteUpdate("owner--alpha", candidate, "alpha")).toBe(
      true
    );
  });

  test("update tasks carry the upstream name from the supplied lock", () => {
    place("active", "owner--alpha", "fixture");
    expect(
      installedExternalUpdateTasks({
        external: {
          "owner--alpha": {
            source: "owner/repo",
            skillPath: "packs/alpha/SKILL.md",
            installSkill: "alpha",
          },
        },
      })
    ).toEqual([
      ["owner/repo", "owner--alpha", "packs/alpha/SKILL.md", "alpha"],
    ]);
  });
});

test("an unselected collision does not block a different import or preview", () => {
  const current: Lock = {
    external: {
      alpha: { source: "first/repo" },
      "owner--alpha": { source: "another/repo" },
    },
  };
  const candidates = [{ name: "alpha" }, { name: "beta" }];
  expect(
    resolveSelectedExternalSkills(
      current,
      "owner/repo",
      new Set(["beta"]),
      candidates
    ).map((row) => row.deployName)
  ).toEqual(["beta"]);
  expect(
    externalPreviewPayload(current, "", "owner/repo", candidates).rows.map(
      (row) => row.name
    )
  ).toEqual(["beta"]);
});

test("a blocked namespace does not shadow a valid upstream candidate", () => {
  const current: Lock = {
    custom: { skills: { alpha: { repoPath: "skills/alpha" } } },
  };
  const candidates = [{ name: "alpha" }, { name: "owner--alpha" }];
  const preview = externalPreviewPayload(current, "", "owner/repo", candidates);
  expect(preview.rows.map((row) => row.name)).toEqual(["owner--alpha"]);
  expect(
    resolveSelectedExternalSkills(
      current,
      "owner/repo",
      new Set(["owner--alpha"]),
      candidates
    ).map((row) => row.upstreamName)
  ).toEqual(["owner--alpha"]);
});
