/**
 * Deck から配布用プラグインパッケージを書き出す。
 *
 * `deck apply` が `~/.agents/skills` へ投影するのに対し、こちらは Deck の
 * 解決済み skill 群を Agent Plugins 標準（root の `plugin.json` + `skills/`）と
 * 各ハーネス用マニフェスト（`.claude-plugin/`・`.cursor-plugin/`・`.codex-plugin/`）
 * を持つパッケージへ投影する。出力先は Catalog ではなく任意のディレクトリで、
 * そこから先の publish / install は利用者の Git リポジトリ側の話なので、
 * Engine が触るのは出力先だけ。
 */

import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveCatalogPath } from "./catalogPaths";
import { activeDir, archiveDir } from "./config";
import { customSkillRepoDir } from "./custom";
import { deckPath, loadDeck, UnknownDeckError, type Deck } from "./decks";
import { ValueError } from "./errors";
import { type Lock, sortNames } from "./inventory";
import { assertSkillName, copySkillTree, writeSkillJson } from "./skill-files";

/** export 対象が解決できなかった skill 名を運ぶ。CLI が一覧を出して 2 で抜ける。 */
export class UnresolvedPluginSkillsError extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super(`Unresolved plugin skills: ${names.join(", ")}`);
    this.names = names;
  }
}

export type PluginExportOptions = {
  /** Project Deck か Shared Deck の名前。Project 側を先に解決する。 */
  deck: string;
  /** パッケージの出力先。存在しないか空のディレクトリ、または `--overwrite` 付きの再出力先。 */
  outDir: string;
  /** plugin.json の `name`。既定は deck 名。 */
  name?: string;
  /** plugin.json の `version`。既定は `1.0.0`。 */
  version?: string;
  /** 説明文。既定は deck の `description`。 */
  description?: string;
  /** 配布先リポジトリ。`owner/repo` か完全な URL。既定は lock の `custom.repo`。 */
  repository?: string;
  /** 既存の生成物を消して出力し直す。 */
  overwrite?: boolean;
};

export type PluginExportResult = {
  dir: string;
  name: string;
  version: string;
  description: string;
  deck: string;
  deckKind: "project" | "shared";
  skills: string[];
  /** 書き出したファイルの outDir 相対パス。検証用。 */
  manifests: string[];
};

// Agent Plugins スキーマの name 口径。セグメント単位の kebab-case で、
// 連続ハイフンや先頭・末尾のハイフンはクライアント側で弾かれるので出さない。
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLUGIN_NAME_MAX_LENGTH = 64;
// semver 緩和版。公開版の付け替えはタグ運用側でやるので、ここでは形だけ見る。
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Project Deck を先に、無ければ Shared Deck を解決する。両方無ければ
 * UnknownDeckError がそのまま上がる。deck 名が衝突したときは Project 側が勝つ。
 */
function resolveDeck(name: string): {
  deck: Deck;
  skills: string[];
  kind: "project" | "shared";
} {
  // まず存在確認だけする。loadDeck まで投げると循環参照のエラーが
  // 「Project deck 無し」と区別できず Shared 側へ流れてしまう。
  let isProject = true;
  try {
    deckPath(name, true);
  } catch (error) {
    if (!(error instanceof UnknownDeckError)) throw error;
    isProject = false;
  }
  const [deck, skills] = loadDeck(name, new Set(), isProject);
  return { deck, skills, kind: isProject ? "project" : "shared" };
}

/**
 * skill 名からコピー元ディレクトリを引く。順序は一覧表示（`skillMetadata`）と同じく
 * custom → vendor → external。external は Catalog 内の `localRepoPath`、
 * 無ければ install 済みの active / archive 側を見る。
 */
function skillSourceDir(lock: Lock, name: string): string | undefined {
  const customDir = customSkillRepoDir(lock, name);
  if (customDir) return customDir;

  if (lock.vendor?.[name]) {
    const dir = resolveCatalogPath(`vendor/${name}`);
    if (exists(dir)) return dir;
  }

  const external = lock.external?.[name];
  if (external) {
    if (external.localRepoPath) {
      const dir = resolveCatalogPath(external.localRepoPath);
      if (exists(dir)) return dir;
    }
    for (const base of [activeDir(), archiveDir()]) {
      const dir = join(base, name);
      if (exists(dir)) return dir;
    }
  }
  return undefined;
}

/**
 * 出力先の確保。空でないディレクトリは、前回の生成物（`plugin.json` がある）かつ
 * `--overwrite` のときだけ消し直す。marker の無い中身入りは利用者のファイルを
 * 消しかねないので常に拒否する。
 */
function prepareOutDir(
  outDir: string,
  overwrite: boolean,
  manifestPaths: string[]
): void {
  if (!exists(outDir)) {
    mkdirSync(outDir, { recursive: true });
    return;
  }
  if (!lstatSync(outDir).isDirectory())
    throw new ValueError(`Plugin output path is not a directory: ${outDir}`);
  if (readdirSync(outDir).length === 0) return;
  if (!exists(join(outDir, "plugin.json")))
    throw new ValueError(
      `Refusing to write into a non-plugin directory: ${outDir}`
    );
  if (!overwrite)
    throw new ValueError(
      `Plugin output already exists: ${outDir} (use --overwrite)`
    );
  // 出力先は配布リポジトリの checkout になりうるので、ディレクトリごとは
  // 消さず生成物だけ消し直す。.git・README・利用者が足したファイルは残る。
  rmSync(join(outDir, "skills"), { recursive: true, force: true });
  for (const relativePath of manifestPaths)
    rmSync(join(outDir, relativePath), { force: true });
}

/** `owner/repo` を `https://github.com/...` に、URL はそのまま返す。 */
function repositoryUrl(repo: string | undefined): string | undefined {
  const raw = repo?.trim();
  if (!raw) return undefined;
  return raw.includes("://") ? raw : `https://github.com/${raw}`;
}

/** marketplace メタデータの owner。`owner/repo` でも URL でも owner 部分だけ拾う。 */
function repoOwner(repo: string | undefined, fallback: string): string {
  const raw = repo?.trim() ?? "";
  if (!raw) return fallback;
  const segments = raw.split("://").at(-1)!.split("/").filter(Boolean);
  const owner = raw.includes("://") ? segments[1] : segments[0];
  return owner?.trim() || fallback;
}

/** description が空ならキー自体を出さない（各マニフェスト共通の組み立て方）。 */
function manifestDescription(description: string): { description?: string } {
  return description ? { description } : {};
}

export function exportPlugin(
  lock: Lock,
  options: PluginExportOptions
): PluginExportResult {
  const name = options.name ?? options.deck;
  if (name.length > PLUGIN_NAME_MAX_LENGTH || !PLUGIN_NAME_PATTERN.test(name))
    throw new ValueError(`Invalid plugin name: ${name}`);
  const version = options.version ?? "1.0.0";
  if (!PLUGIN_VERSION_PATTERN.test(version))
    throw new ValueError(`Invalid plugin version: ${version}`);

  const { deck, skills, kind } = resolveDeck(options.deck);
  const description = options.description ?? deck.description ?? "";

  const sources = new Map<string, string>();
  const unresolved: string[] = [];
  for (const skillName of skills) {
    // 出力側の skills/<name> を壊さないよう、deck の並びも skill 名として検証する。
    assertSkillName(skillName);
    const dir = skillSourceDir(lock, skillName);
    if (!dir || !exists(join(dir, "SKILL.md"))) {
      unresolved.push(skillName);
      continue;
    }
    sources.set(skillName, dir);
  }
  if (unresolved.length > 0) throw new UnresolvedPluginSkillsError(unresolved);

  const repo = options.repository ?? lock.custom?.repo;
  const repository = repositoryUrl(repo);
  const marketplaceOwner = { name: repoOwner(repo, name) };

  const manifestFiles: [string, unknown][] = [
    [
      "plugin.json",
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
        version,
        ...manifestDescription(description),
        ...(repository ? { repository } : {}),
      },
    ],
    [
      join(".claude-plugin", "plugin.json"),
      {
        name,
        version,
        ...manifestDescription(description),
        ...(repository ? { repository } : {}),
      },
    ],
    [
      join(".claude-plugin", "marketplace.json"),
      {
        $schema: "https://code.claude.com/schemas/marketplace.json",
        name: `${name}-marketplace`,
        owner: marketplaceOwner,
        plugins: [
          {
            name,
            source: "./",
            ...manifestDescription(description),
          },
        ],
      },
    ],
    [
      join(".cursor-plugin", "plugin.json"),
      {
        name,
        version,
        ...manifestDescription(description),
      },
    ],
    [
      join(".cursor-plugin", "marketplace.json"),
      {
        name: `${name}-marketplace`,
        owner: marketplaceOwner,
        plugins: [
          {
            name,
            source: "./",
            ...manifestDescription(description),
          },
        ],
      },
    ],
    [
      join(".codex-plugin", "plugin.json"),
      {
        name,
        version,
        ...manifestDescription(description),
        skills: "./skills/",
      },
    ],
  ];

  prepareOutDir(
    options.outDir,
    options.overwrite ?? false,
    manifestFiles.map(([relativePath]) => relativePath)
  );

  const skillsDir = join(options.outDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  for (const [skillName, dir] of sources)
    copySkillTree(dir, join(skillsDir, skillName));

  for (const [relativePath, manifest] of manifestFiles)
    writeSkillJson(join(options.outDir, relativePath), manifest);

  return {
    dir: options.outDir,
    name,
    version,
    description,
    deck: options.deck,
    deckKind: kind,
    skills: sortNames(sources.keys()),
    manifests: manifestFiles.map(([relativePath]) => relativePath),
  };
}
