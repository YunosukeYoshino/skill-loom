/**
 * Deck の読み書き。
 *
 * `bin/my-skills.py` の `list_project_decks` / `deck_path` / `load_deck` の移植に加え、
 * Project Deck の選択保存と空 Deck 作成を担う。
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { decksDir, GLOBAL_INSTALL_AGENTS, projectDecksDir } from "./config";
import { canonicalPath } from "./catalogPaths";
import { AlreadyExistsError, ValueError } from "./errors";
import type { Lock } from "./inventory";

export type Deck = {
  name?: string;
  description?: string;
  extends?: string[];
  skills?: string[];
};

/** deck が存在しないときに投げる。移行前の `SystemExit` に対応する。 */
export class UnknownDeckError extends Error {}

/** preset と同じく、UI / CLI から作る名前は小文字・数字・ハイフンだけ。 */
const PROJECT_DECK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** `Path.rglob("*.json")` 相当。Python は結果をフルパスの文字列順に並べる。 */
function findJsonFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path);
      else if (entry.endsWith(".json")) found.push(path);
    }
  };
  walk(root);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function listProjectDecks(): string[] {
  const root = projectDecksDir();
  if (!exists(root)) return [];
  return findJsonFiles(root).map((path) =>
    relative(root, path).replace(/\.json$/, "")
  );
}

/**
 * Project Deck 名の検証。パターンがパス区切り・`..`・長さ上限を弾くので、
 * この検証を通った名前は作成時に Catalog 外へ書けない。既存のネスト deck の
 * 読み込みは `deckPath` 側が担当する。
 */
export function validateProjectDeckName(name: string): void {
  if (!PROJECT_DECK_NAME_PATTERN.test(name))
    throw new ValueError(`Invalid project deck name: ${name}`);
}

/**
 * 空の Project Deck を `project-decks/<name>.json` に作ってパスを返す。
 *
 * 既存を上書きしない（409）。Apply 時の Core union は projection 側の責務なので、
 * ここは `skills: []` の最小ファイルだけを置く。
 */
export function createEmptyProjectDeck(name: string, description = ""): string {
  // 名前は検証済みなので、`${name}.json` が base の外へ出ることは無い。
  validateProjectDeckName(name);
  const base = projectDecksDir();
  mkdirSync(base, { recursive: true });
  const path = resolve(base, `${name}.json`);
  if (exists(path))
    throw new AlreadyExistsError(`Project deck already exists: ${name}`);

  const deck: Deck = { name, skills: [] };
  if (description) deck.description = description;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(deck, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/**
 * resolve（字面の正規化）と symlink 解決（実体パス）の両面で、path が base の
 * 外へ出ていないことを保証する。resolve は symlink を追わないので、配下に
 * 外部を指す symlink があっても実体側の判定で弾ける。
 */
function assertInsideBase(base: string, path: string, name: string): void {
  const checks: [string, string][] = [
    [resolve(base), path],
    [canonicalPath(resolve(base)), canonicalPath(path)],
  ];
  for (const [root, candidate] of checks) {
    const fromBase = relative(root, candidate);
    if (
      fromBase === ".." ||
      fromBase.startsWith(`..${sep}`) ||
      isAbsolute(fromBase)
    )
      throw new UnknownDeckError(`Deck path escapes its root: ${name}`);
  }
}

export function deckPath(name: string, project = false): string {
  const base = project ? projectDecksDir() : decksDir();
  if (isAbsolute(name))
    throw new UnknownDeckError(`Deck path must be relative: ${name}`);
  const path = resolve(base, `${name}.json`);
  assertInsideBase(base, path, name);
  if (exists(path)) return path;
  // 拡張子込みで指定された場合も受ける（移行前の nested 分岐）。
  const nested = resolve(base, name);
  assertInsideBase(base, nested, name);
  if (name.endsWith(".json") && exists(nested)) return nested;
  throw new UnknownDeckError(
    `Unknown ${project ? "project deck" : "deck"}: ${name}`
  );
}

/** `extends` を辿って skill 名を集める。循環は移行前と同じくエラーにする。 */
export function loadDeck(
  name: string,
  seen: Set<string> = new Set(),
  project = false
): [Deck, string[]] {
  const seenKey = `${project ? "project" : "deck"}:${name}`;
  if (seen.has(seenKey))
    throw new UnknownDeckError(`Deck cycle detected: ${name}`);
  const nextSeen = new Set(seen);
  nextSeen.add(seenKey);

  const deck = JSON.parse(
    readFileSync(deckPath(name, project), "utf-8")
  ) as Deck;

  const skills: string[] = [];
  for (const parent of deck.extends ?? []) {
    // 親は常にリポジトリ同梱 deck 側を見る（移行前も project を引き継がない）。
    const [, parentSkills] = loadDeck(parent, nextSeen);
    skills.push(...parentSkills);
  }
  skills.push(...(deck.skills ?? []));

  const unique = [...new Set(skills)];
  return [deck, unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
}

/**
 * project deck の直接指定 skill を書き換え、書き込んだ件数を返す。
 *
 * 親 deck (`extends`) から来る skill は保存しない。保存すると親を変えても
 * 子が古い一覧を握り続け、継承の意味が無くなる。
 */
export function saveProjectDeckSelection(
  deckName: string,
  selected: Set<string>
): number {
  const path = deckPath(deckName, true);
  const deck = JSON.parse(readFileSync(path, "utf-8")) as Deck;

  const inherited = new Set<string>();
  for (const parent of deck.extends ?? []) {
    const [, parentSkills] = loadDeck(parent);
    for (const name of parentSkills) inherited.add(name);
  }

  deck.skills = [...selected]
    .filter((name) => !inherited.has(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(deck, null, 2)}\n`);
  renameSync(tmp, path);
  return deck.skills.length;
}

/**
 * 既存の直接指定に足し込み、足したあとの件数を返す。
 *
 * `saveProjectDeckSelection` と違って継承分を落とさない。外部 skill の取り込みは
 * 「今の deck に足す」操作なので、親から来ている名前を選んでいたら素直に直接指定へ落ちる。
 */
export function addSkillsToProjectDeck(
  deckName: string,
  selected: Set<string>
): number {
  const path = deckPath(deckName, true);
  const deck = JSON.parse(readFileSync(path, "utf-8")) as Deck;
  deck.skills = [...new Set([...(deck.skills ?? []), ...selected])].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  );
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(deck, null, 2)}\n`);
  renameSync(tmp, path);
  return deck.skills.length;
}

/**
 * deck の中身ごと skill 一覧を差し替えて保存し、書いたパスを返す。
 *
 * 外部 skill の取り込みは `loadOptionalProjectDeck` が返す**解決済み**の一覧に足すので、
 * `extends` から来ている skill もこの経路では直接指定として書き戻る。移行前からの挙動。
 */
export function writeProjectDeckSkills(
  deckName: string,
  deck: Deck,
  skills: Set<string>
): string {
  const path = deckPath(deckName, true);
  deck.skills = [...skills].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(deck, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/** deck 名が空なら「deck 無し（global 側）」。外部取り込みは deck 経由でも global 直でも来る。 */
export function loadOptionalProjectDeck(deckName: string): [Deck, string[]] {
  if (!deckName) return [{}, []];
  return loadDeck(deckName, new Set(), true);
}

/**
 * Python の `shlex.quote`。UI に出す install コマンドは貼り付けて実行される前提なので、
 * 引用の付き方まで移行前と合わせる。安全文字の集合は `[^\w@%+=:,./-]` (re.ASCII) と同じ。
 */
function shellQuote(value: string): string {
  if (value === "") return "''";
  if (!/[^\w@%+=:,./-]/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * deck の skill を入れ直すための `skills add --project` コマンド。source ごとに 1 本。
 *
 * 並びは skill の並び順に現れた source 順（移行前の `defaultdict` の挿入順）。
 * 取得元の分からない skill は入れ直しようが無いので、コマンドに載せない。
 */
export function projectDeckInstallCommands(
  lock: Lock,
  skills: string[]
): string[] {
  const custom = lock.custom?.skills ?? {};
  const customRepo = lock.custom?.repo ?? "";
  const external = lock.external ?? {};

  const bySource = new Map<string, string[]>();
  for (const name of skills) {
    let source = "";
    let installName = name;
    if (name in external) {
      source = external[name]?.source ?? "";
      installName = external[name]?.installSkill ?? name;
    } else if (name in custom) {
      source = customRepo;
    }
    if (!source) continue;
    const names = bySource.get(source);
    if (names) names.push(installName);
    else bySource.set(source, [installName]);
  }

  return [...bySource].map(([source, names]) => {
    const parts = ["npx", "skills", "add", source, "--project"];
    for (const name of names) parts.push("--skill", name);
    for (const agent of GLOBAL_INSTALL_AGENTS) parts.push("-a", agent);
    parts.push("-y");
    return parts.map(shellQuote).join(" ");
  });
}
