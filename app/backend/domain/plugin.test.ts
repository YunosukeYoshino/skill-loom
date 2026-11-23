/**
 * `plugin export` のテスト。
 *
 * custom / vendor / external の各ソースから skills/ への投影、Deck 解決の
 * 優先順位、出力先の保護を一時 Catalog で固定する。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lock } from "./inventory";
import {
  exportPlugin,
  UnresolvedPluginSkillsError,
  type PluginExportResult,
} from "./plugin";
import { ValueError } from "./errors";
import { UnknownDeckError } from "./decks";

let catalog: string;
let outDir: string;
let activeDir: string;
let archiveDir: string;
const touched: string[] = [];

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

function writeSkill(root: string, extra?: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "SKILL.md"),
    "---\nname: fixture\ndescription: fixture skill\n---\n"
  );
  for (const [path, content] of Object.entries(extra ?? {})) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
}

function writeProjectDeck(name: string, deck: unknown): void {
  mkdirSync(join(catalog, "project-decks"), { recursive: true });
  writeFileSync(
    join(catalog, "project-decks", `${name}.json`),
    JSON.stringify(deck)
  );
}

function writeSharedDeck(name: string, deck: unknown): void {
  mkdirSync(join(catalog, "shared-decks"), { recursive: true });
  writeFileSync(
    join(catalog, "shared-decks", `${name}.json`),
    JSON.stringify(deck)
  );
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const lock: Lock = {
  version: 1,
  custom: {
    repo: "owner/catalog",
    skills: {
      alpha: { repoPath: "skills/fixture/alpha", category: "fixture" },
    },
  },
  external: {
    ext: { source: "acme/pack", localRepoPath: "vendor-local/ext" },
    installed: { source: "acme/pack" },
    missing: { source: "acme/pack" },
  },
  vendor: {
    vend: { source: "acme/pack" },
  },
};

function run(
  overrides: Partial<Parameters<typeof exportPlugin>[1]> = {}
): PluginExportResult {
  return exportPlugin(lock, {
    deck: "pack",
    outDir,
    ...overrides,
  });
}

beforeEach(() => {
  catalog = mkdtempSync(join(tmpdir(), "skill-loom-plugin-catalog-"));
  outDir = mkdtempSync(join(tmpdir(), "skill-loom-plugin-out-"));
  activeDir = mkdtempSync(join(tmpdir(), "skill-loom-plugin-active-"));
  archiveDir = mkdtempSync(join(tmpdir(), "skill-loom-plugin-archive-"));

  writeSkill(join(catalog, "skills", "fixture", "alpha"), {
    "scripts/run.sh": "#!/bin/sh\n",
  });
  writeSkill(join(catalog, "vendor", "vend"));
  writeSkill(join(catalog, "vendor-local", "ext"));
  writeSkill(join(activeDir, "installed"));
  writeProjectDeck("pack", {
    name: "pack",
    description: "Pack deck",
    skills: ["alpha", "vend", "ext", "installed"],
  });

  setEnv("MY_SKILLS_CATALOG_DIR", catalog);
  setEnv("MY_SKILLS_PROJECT_DECKS_DIR", join(catalog, "project-decks"));
  setEnv("MY_SKILLS_ACTIVE_DIR", activeDir);
  setEnv("MY_SKILLS_ARCHIVE_DIR", archiveDir);
});

afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name];
  for (const dir of [catalog, outDir, activeDir, archiveDir])
    rmSync(dir, { recursive: true, force: true });
});

describe("exportPlugin", () => {
  test("各ソースの skill を skills/ へ写し、全マニフェストを出す", () => {
    const result = run();

    expect(result.deckKind).toBe("project");
    expect(result.skills).toEqual(["alpha", "ext", "installed", "vend"]);

    // ツリーごとコピーされる（SKILL.md 以外のファイルも）。
    expect(
      existsSync(join(outDir, "skills", "alpha", "scripts", "run.sh"))
    ).toBe(true);
    expect(existsSync(join(outDir, "skills", "vend", "SKILL.md"))).toBe(true);
    expect(existsSync(join(outDir, "skills", "ext", "SKILL.md"))).toBe(true);
    expect(existsSync(join(outDir, "skills", "installed", "SKILL.md"))).toBe(
      true
    );

    expect(readJson(join(outDir, "plugin.json"))).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "pack",
      version: "1.0.0",
      description: "Pack deck",
      repository: "https://github.com/owner/catalog",
    });
    expect(
      readJson(join(outDir, ".claude-plugin", "marketplace.json"))
    ).toEqual({
      $schema: "https://code.claude.com/schemas/marketplace.json",
      name: "pack-marketplace",
      owner: { name: "owner" },
      plugins: [{ name: "pack", source: "./", description: "Pack deck" }],
    });
    expect(readJson(join(outDir, ".cursor-plugin", "plugin.json"))).toEqual({
      name: "pack",
      version: "1.0.0",
      description: "Pack deck",
    });
    expect(readJson(join(outDir, ".codex-plugin", "plugin.json"))).toEqual({
      name: "pack",
      version: "1.0.0",
      description: "Pack deck",
      skills: "./skills/",
    });
    expect(result.manifests).toContain(join(".claude-plugin", "plugin.json"));
  });

  test("description は option > deck の順に選ぶ", () => {
    expect(run({ description: "override" }).description).toBe("override");
    writeProjectDeck("plain", { name: "plain", skills: ["alpha"] });
    const secondOut = mkdtempSync(join(tmpdir(), "skill-loom-plugin-out2-"));
    try {
      const plain = run({ deck: "plain", outDir: secondOut });
      expect(plain.description).toBe("");
      expect(
        readJson(join(secondOut, "plugin.json")).description
      ).toBeUndefined();
    } finally {
      rmSync(secondOut, { recursive: true, force: true });
    }
  });

  test("--repository は lock の catalog repo より優先して manifest に入る", () => {
    run({ repository: "acme/distributed-pack" });
    const plugin = readJson(join(outDir, "plugin.json"));
    expect(plugin.repository).toBe("https://github.com/acme/distributed-pack");
    const marketplace = readJson(
      join(outDir, ".claude-plugin", "marketplace.json")
    ) as { owner: { name: string } };
    expect(marketplace.owner.name).toBe("acme");
  });

  test("Project Deck が無いときは Shared Deck から出す", () => {
    writeSharedDeck("shared-pack", {
      name: "shared-pack",
      skills: ["alpha"],
    });

    const result = run({ deck: "shared-pack" });
    expect(result.deckKind).toBe("shared");
    expect(result.skills).toEqual(["alpha"]);
  });

  test("Project と同名の Shared があるときは Project を優先する", () => {
    writeSharedDeck("pack", { name: "pack", skills: ["vend"] });

    const result = run();
    expect(result.deckKind).toBe("project");
    expect(result.skills).toContain("alpha");
  });

  test("解決できない skill があれば名前を挙げて失敗し、出力しない", () => {
    writeProjectDeck("broken", {
      name: "broken",
      skills: ["alpha", "missing", "unknown"],
    });

    let thrown: unknown;
    try {
      run({ deck: "broken" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnresolvedPluginSkillsError);
    expect((thrown as UnresolvedPluginSkillsError).names).toEqual([
      "missing",
      "unknown",
    ]);
    expect(existsSync(join(outDir, "plugin.json"))).toBe(false);
  });

  test("存在しない deck は UnknownDeckError", () => {
    expect(() => run({ deck: "nope" })).toThrow(UnknownDeckError);
  });

  test("archive 側だけにある external skill も拾う", () => {
    writeSkill(join(archiveDir, "installed"));
    rmSync(join(activeDir, "installed"), { recursive: true });

    const result = run({ name: "pack-archive" });
    expect(existsSync(join(outDir, "skills", "installed", "SKILL.md"))).toBe(
      true
    );
    expect(result.name).toBe("pack-archive");
  });

  test("plugin 名と version を検証する", () => {
    for (const name of [
      "Bad Name",
      "UPPER",
      "",
      "has_underscore",
      "pack--test",
      "-lead",
      "trail-",
    ]) {
      expect(() => run({ name })).toThrow(ValueError);
    }
    for (const version of ["v1", "1.0", "x.y.z"]) {
      expect(() => run({ version })).toThrow(ValueError);
    }
    expect(run({ name: "ok-name", version: "2.0.0-beta.1" }).version).toBe(
      "2.0.0-beta.1"
    );
  });

  test("中身のある非 plugin ディレクトリは拒否する", () => {
    writeFileSync(join(outDir, "keep.txt"), "mine");

    expect(() => run()).toThrow(ValueError);
    expect(() => run({ overwrite: true })).toThrow(ValueError);
    expect(existsSync(join(outDir, "keep.txt"))).toBe(true);
  });

  test("再出力は --overwrite が要る", () => {
    run();
    expect(() => run()).toThrow(ValueError);
    expect(() => run({ overwrite: true })).not.toThrow();
    expect(readJson(join(outDir, "plugin.json")).name).toBe("pack");
  });

  test("--overwrite は生成物だけ消し直し、配布 repo のファイルを残す", () => {
    run();
    // 配布リポジトリ側にしかないファイル
    writeFileSync(join(outDir, "README.md"), "dist repo readme");
    mkdirSync(join(outDir, ".git"), { recursive: true });
    writeFileSync(join(outDir, ".git", "HEAD"), "ref: refs/heads/main");
    // 前回の生成物に紛れた古い skill や手書き追加
    mkdirSync(join(outDir, "skills", "stale"), { recursive: true });
    writeFileSync(join(outDir, "skills", "stale", "SKILL.md"), "old");

    run({ overwrite: true });

    expect(readFileSync(join(outDir, "README.md"), "utf8")).toBe(
      "dist repo readme"
    );
    expect(readFileSync(join(outDir, ".git", "HEAD"), "utf8")).toBe(
      "ref: refs/heads/main"
    );
    expect(existsSync(join(outDir, "skills", "stale"))).toBe(false);
    expect(existsSync(join(outDir, "skills", "alpha", "SKILL.md"))).toBe(true);
  });

  test("manifest ディレクトリのシンボリックリンクは拒否しリンク先を触らない", () => {
    run();
    // 配布 repo の .claude-plugin が外部ディレクトリへのリンクに差し替わった状態
    const outside = mkdtempSync(join(tmpdir(), "skill-loom-plugin-outside-"));
    writeFileSync(join(outside, "plugin.json"), "outside file");
    rmSync(join(outDir, ".claude-plugin"), { recursive: true });
    symlinkSync(outside, join(outDir, ".claude-plugin"));

    expect(() => run({ overwrite: true })).toThrow(ValueError);
    expect(readFileSync(join(outside, "plugin.json"), "utf8")).toBe(
      "outside file"
    );
    expect(existsSync(join(outside, "marketplace.json"))).toBe(false);
  });

  test("空の deck でも空の skills/ と manifest を出す", () => {
    writeProjectDeck("empty", { name: "empty", skills: [] });

    const result = run({ deck: "empty" });
    expect(result.skills).toEqual([]);
    expect(existsSync(join(outDir, "skills"))).toBe(true);
    expect(existsSync(join(outDir, "plugin.json"))).toBe(true);
  });
});
