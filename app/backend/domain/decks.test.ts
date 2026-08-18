/**
 * Deck の保存と install コマンド生成のテスト。
 *
 * Project Deck と Shared Deck の両方を一時 Catalog に置き、Engine checkout の
 * Catalog data に依存しない形で読み書きする。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
  addSkillsToProjectDeck,
  createEmptyProjectDeck,
  loadDeck,
  loadOptionalProjectDeck,
  projectDeckInstallCommands,
  saveProjectDeckSelection,
  writeProjectDeckSkills,
} from "./decks";
import { AlreadyExistsError, ValueError } from "./errors";
import type { Lock } from "./inventory";

let sandbox: string;
const touched: string[] = [];

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

function writeDeck(name: string, deck: unknown): void {
  writeFileSync(join(sandbox, `${name}.json`), JSON.stringify(deck, null, 2));
}

function readDeck(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sandbox, `${name}.json`), "utf8"));
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-decks-"));
  mkdirSync(join(sandbox, "shared-decks"), { recursive: true });
  writeFileSync(
    join(sandbox, "shared-decks", "core.json"),
    JSON.stringify({ name: "core", skills: ["core-skill"] })
  );
  setEnv("MY_SKILLS_CATALOG_DIR", sandbox);
  setEnv("MY_SKILLS_PROJECT_DECKS_DIR", sandbox);
});

afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name];
  rmSync(sandbox, { recursive: true, force: true });
});

describe("createEmptyProjectDeck", () => {
  test("空の project deck を作り、パスを返す", () => {
    const path = createEmptyProjectDeck("work");

    expect(path).toBe(join(sandbox, "work.json"));
    expect(readDeck("work")).toEqual({ name: "work", skills: [] });
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  test("description があれば残す", () => {
    createEmptyProjectDeck("docs", "Docs deck");

    expect(readDeck("docs")).toEqual({
      name: "docs",
      description: "Docs deck",
      skills: [],
    });
  });

  test("既存 deck は作らない", () => {
    writeDeck("work", { name: "work", skills: [] });

    expect(() => createEmptyProjectDeck("work")).toThrow(AlreadyExistsError);
    expect(() => createEmptyProjectDeck("work")).toThrow(
      "Project deck already exists: work"
    );
  });

  test("不正な名前は弾く", () => {
    for (const name of ["", "Bad", "has space", "../escape", "a".repeat(65)]) {
      expect(() => createEmptyProjectDeck(name)).toThrow(ValueError);
    }
    expect(existsSync(join(sandbox, "../escape.json"))).toBe(false);
  });
});

describe("saveProjectDeckSelection", () => {
  test("選択を名前順に書き戻し、件数を返す", () => {
    writeDeck("api", { name: "api", description: "API deck", skills: ["old"] });

    expect(
      saveProjectDeckSelection("api", new Set(["gamma", "alpha", "beta"]))
    ).toBe(3);
    // description などの他のキーは残す。deck を保存しただけで説明が消えないこと。
    expect(readDeck("api")).toEqual({
      name: "api",
      description: "API deck",
      skills: ["alpha", "beta", "gamma"],
    });
  });

  test("親 deck から継承した skill は保存しない", () => {
    writeDeck("api", { extends: ["core"], skills: [] });
    const [, coreSkills] = loadDeck("core");
    const inherited = coreSkills[0] as string;

    expect(
      saveProjectDeckSelection("api", new Set([inherited, "own-skill"]))
    ).toBe(1);
    // 継承分を書き込むと、親を変えても子が古い一覧を握り続ける。
    expect(readDeck("api").skills).toEqual(["own-skill"]);
  });

  test("末尾に改行を付ける", () => {
    writeDeck("api", { skills: [] });
    saveProjectDeckSelection("api", new Set(["alpha"]));

    expect(readFileSync(join(sandbox, "api.json"), "utf8").endsWith("\n")).toBe(
      true
    );
  });
});

describe("projectDeckInstallCommands", () => {
  const lock: Lock = {
    custom: {
      repo: "owner/my-skills",
      skills: { mine: { repoPath: "skills/a/mine" } },
    },
    external: {
      ext: { source: "acme/pack" },
      renamed: { source: "acme/pack", installSkill: "upstream-name" },
      other: { source: "third/party" },
    },
  };

  test("source ごとに 1 本へまとめる", () => {
    expect(
      projectDeckInstallCommands(lock, ["ext", "renamed", "other"])
    ).toEqual([
      "npx skills add acme/pack --project --skill ext --skill upstream-name -a claude-code -a codex -a antigravity -y",
      "npx skills add third/party --project --skill other -a claude-code -a codex -a antigravity -y",
    ]);
  });

  test("custom skill は lock の repo から入れ直す", () => {
    expect(projectDeckInstallCommands(lock, ["mine"])).toEqual([
      "npx skills add owner/my-skills --project --skill mine -a claude-code -a codex -a antigravity -y",
    ]);
  });

  test("custom の repo が無ければ install command を作らない", () => {
    const bare: Lock = {
      custom: { skills: { mine: { repoPath: "skills/a/mine" } } },
    };
    expect(projectDeckInstallCommands(bare, ["mine"])).toEqual([]);
  });

  test("取得元の分からない skill はコマンドに載せない", () => {
    expect(projectDeckInstallCommands(lock, ["unknown"])).toEqual([]);
  });

  test("シェルに渡せない文字は引用する", () => {
    const odd: Lock = { external: { weird: { source: "a b;rm -rf /" } } };
    expect(projectDeckInstallCommands(odd, ["weird"])[0]).toContain(
      "'a b;rm -rf /'"
    );
  });
});

describe("addSkillsToProjectDeck", () => {
  test("既存の直接指定に足し込み、足したあとの件数を返す", () => {
    writeDeck("api", { name: "api", skills: ["beta"] });

    expect(addSkillsToProjectDeck("api", new Set(["alpha", "beta"]))).toBe(2);
    expect(readDeck("api")).toEqual({ name: "api", skills: ["alpha", "beta"] });
  });
});

describe("writeProjectDeckSkills", () => {
  test("渡した一覧で skills を差し替え、書いたパスを返す", () => {
    writeDeck("api", { name: "api", extends: ["core"], skills: ["old"] });
    const [deck] = loadOptionalProjectDeck("api");

    const path = writeProjectDeckSkills(
      "api",
      deck,
      new Set(["gamma", "alpha"])
    );

    expect(path).toBe(join(sandbox, "api.json"));
    // extends はそのまま残り、skills だけが入れ替わる。
    expect(readDeck("api")).toEqual({
      name: "api",
      extends: ["core"],
      skills: ["alpha", "gamma"],
    });
  });
});

describe("loadOptionalProjectDeck", () => {
  test("deck 名が空なら空の deck を返す", () => {
    expect(loadOptionalProjectDeck("")).toEqual([{}, []]);
  });

  test("deck 名があれば親も解決した一覧を返す", () => {
    writeDeck("api", { extends: ["core"], skills: ["zz-own"] });
    const [, coreSkills] = loadDeck("core");

    expect(loadOptionalProjectDeck("api")[1]).toEqual(
      [...coreSkills, "zz-own"].sort()
    );
  });
});
