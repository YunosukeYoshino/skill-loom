/**
 * Inventory の読み取り経路。
 *
 * `bin/my-skills.py` の同名関数の移植。返す値は 1 バイトも変えない。
 *
 * 移植で落としやすい差異を 2 つ、明示的に踏まないようにしている:
 *  - Python の `Path.is_dir()` は symlink を辿る。Projection 先の skill は symlink な
 *    ことがあるので、`lstat` ではなく `stat` で判定する。
 *  - Python の `sorted()` は code point 順。JS の既定 sort は UTF-16 code unit 順で、
 *    BMP 内では一致する。skill 名は kebab-case なので実害は無いが、比較関数を
 *    1 箇所に閉じ込めて意図を残す。
 */

import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  activeDir,
  archiveDir,
  globalLockFile,
  ignoreFile,
  lockFile,
  REPO_LOCAL_SKILLS_DIR,
} from "./config";
import { resolveCatalogPath } from "./catalogPaths";
import { parseInventoryLock } from "./inventory-lock-schema";

// ---- 型 ----

export type CustomSkillMeta = { repoPath?: string; category?: string };
/**
 * `installSkill` は skill 名と `skills add --skill` に渡す名前がずれる場合の逃げ道。
 * 書き手はおらず deck の install コマンド生成だけが読む。移行前も同じ扱い。
 */
export type ExternalSkillMeta = {
  source?: string;
  sourceUrl?: string;
  skillPath?: string;
  localRepoPath?: string;
  installSkill?: string;
};

/** domain 計算は、テストや変更計画で必要な部分だけを持つ Lock も受け付ける。 */
export type Lock = {
  version?: 1;
  custom?: { repo?: string; skills?: Record<string, CustomSkillMeta | string> };
  external?: Record<string, ExternalSkillMeta>;
  vendor?: Record<string, { source?: string }>;
};

/**
 * `~/.agents/.skill-lock.json` の 1 エントリ。書くのは skills CLI で、こちらは読むだけ。
 * `skillFolderHash` は CLI が更新判定に使う git tree SHA で、これが無いと
 * 更新確認は内容ハッシュへフォールバックする。
 */
export type GlobalLockEntry = {
  source?: string;
  sourceType?: string;
  /** install 済み外部 skill を lock へ載せ直すときに、こちらを実際の取得元として写す。 */
  sourceUrl?: string;
  skillPath?: string;
  skillFolderHash?: string;
  ref?: string;
};

export type SkillState = "active" | "archive" | "missing";
export type Selection = "active" | "off" | "archive";

export type SkillRow = {
  name: string;
  category: string;
  description: string;
  source: string;
  state: SkillState;
  checked: boolean;
};

export type TristateRow = {
  name: string;
  category: string;
  description: string;
  source: string;
  state: SkillState;
  selection: Selection;
  can_activate: boolean;
};

// ---- 小道具 ----

/** Python の `sorted()` と同じ code point 順。 */
export function sortNames(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isDir(path: string): boolean {
  try {
    // statSync は symlink を辿る。壊れた symlink は例外になり、Python の is_dir() が
    // False を返すのと一致する。
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function difference(base: Set<string>, ...others: Set<string>[]): Set<string> {
  const out = new Set(base);
  for (const other of others) for (const name of other) out.delete(name);
  return out;
}

function union(...sets: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const set of sets) for (const name of set) out.add(name);
  return out;
}

// ---- lock ----

export function loadLock(): Lock {
  const path = lockFile();
  let data: unknown;
  try {
    data = readJson(path);
  } catch {
    throw new Error(`${path}: invalid JSON`);
  }
  return parseInventoryLock(data, path);
}

/** lock の書き戻し。tmp へ書いてから rename するので、途中で落ちても半端な lock は残らない。 */
export function saveLock(lock: Lock): void {
  const path = lockFile();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  renameSync(tmp, path);
}

/** skills CLI 側の lock。壊れていても落とさず {} を返すのが移行前の挙動。 */
export function loadGlobalLock(): Record<string, GlobalLockEntry> {
  const path = globalLockFile();
  if (!exists(path)) return {};
  try {
    const data = readJson(path);
    if (typeof data !== "object" || data === null) return {};
    const skills = (data as { skills?: unknown }).skills;
    if (typeof skills !== "object" || skills === null) return {};
    return skills as Record<string, GlobalLockEntry>;
  } catch {
    return {};
  }
}

export function ignoredSkills(): Set<string> {
  const path = ignoreFile();
  if (!exists(path)) return new Set();
  const data = readJson(path) as { ignore?: string[] };
  return new Set(data.ignore ?? []);
}

/**
 * 取り込んだ skill を ignore 一覧から外す。外した件数を返す。
 * 一度 ignore した skill を後から取り込むと、管理対象なのに一覧から消えたままになる。
 */
export function removeIgnoredSkills(names: Set<string>): number {
  const path = ignoreFile();
  if (names.size === 0 || !exists(path)) return 0;
  const data = readJson(path) as { ignore?: string[] };
  const ignored = data.ignore ?? [];
  const updated = ignored.filter((name) => !names.has(name));
  const removed = ignored.length - updated.length;
  if (removed === 0) return 0;
  data.ignore = updated;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
  return removed;
}

// ---- 非表示判定 ----

/** リポジトリ運用専用の skill（`.agents/skills/`）。global 一覧には出さない。 */
export function repoLocalSkillNames(): Set<string> {
  if (!isDir(REPO_LOCAL_SKILLS_DIR)) return new Set();
  const names = new Set<string>();
  for (const entry of readdirSync(REPO_LOCAL_SKILLS_DIR)) {
    const dir = join(REPO_LOCAL_SKILLS_DIR, entry);
    if (isDir(dir) && exists(join(dir, "SKILL.md"))) names.add(entry);
  }
  return names;
}

/** lock に載っていても repoPath が `.agents/skills/` 配下なら管理用扱い。 */
export function repoLocalCustomSkills(lock: Lock): Set<string> {
  const names = new Set<string>();
  for (const [name, meta] of Object.entries(lock.custom?.skills ?? {})) {
    const repoPath = typeof meta === "string" ? meta : (meta.repoPath ?? "");
    if (String(repoPath).startsWith(".agents/skills/")) names.add(name);
  }
  return names;
}

export function hiddenGlobalSkills(lock: Lock): Set<string> {
  return union(
    repoLocalSkillNames(),
    repoLocalCustomSkills(lock),
    ignoredSkills()
  );
}

// ---- 在庫 ----

export function trackedSkills(lock: Lock): Set<string> {
  const ignored = ignoredSkills();
  const custom = difference(
    new Set(Object.keys(lock.custom?.skills ?? {})),
    repoLocalCustomSkills(lock),
    ignored
  );
  const external = difference(
    new Set(Object.keys(lock.external ?? {})),
    ignored
  );
  return union(custom, external);
}

export function installedNames(path: string): Set<string> {
  if (!exists(path)) return new Set();
  const names = new Set<string>();
  for (const entry of readdirSync(path)) {
    if (entry === ".system") continue;
    if (isDir(join(path, entry))) names.add(entry);
  }
  return names;
}

export function visibleInstalledNames(lock: Lock, path: string): Set<string> {
  return difference(installedNames(path), hiddenGlobalSkills(lock));
}

export function allSkillNames(lock: Lock): Set<string> {
  const names = union(
    trackedSkills(lock),
    installedNames(activeDir()),
    installedNames(archiveDir())
  );
  return difference(names, hiddenGlobalSkills(lock));
}

export function visibleGlobalSkillNames(lock: Lock): Set<string> {
  return difference(allSkillNames(lock), hiddenGlobalSkills(lock));
}

export function managedActiveSkills(lock: Lock): Set<string> {
  const active = visibleInstalledNames(lock, activeDir());
  const tracked = trackedSkills(lock);
  return new Set([...active].filter((name) => tracked.has(name)));
}

// ---- SKILL.md ----

/**
 * frontmatter の description を取り出す。
 * `description: >` / `|` のブロックスカラーは、字下げが続く間だけ拾って 1 行に畳む。
 */
export function frontmatterDescription(path: string): string {
  if (!exists(path)) return "";
  const lines = readFileSync(path, "utf-8").split(/\r\n|\r|\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") return "";

  const description: string[] = [];
  let capture = false;
  for (const line of lines.slice(1)) {
    const stripped = line.trim();
    if (stripped === "---") break;
    if (capture) {
      if (line.startsWith(" ") || line.startsWith("\t")) {
        description.push(stripped);
        continue;
      }
      break;
    }
    if (stripped.startsWith("description:")) {
      const value = stripped.slice("description:".length).trim();
      if (value === ">" || value === "|" || value === ">-" || value === "|-") {
        capture = true;
        continue;
      }
      return stripQuotes(value);
    }
  }
  return stripQuotes(description.filter((part) => part).join(" "));
}

/** Python の `str.strip("\"'")` と同じく、両端の " と ' をまとめて剥がす。 */
function stripQuotes(value: string): string {
  return value.replace(/^["']+/, "").replace(/["']+$/, "");
}

// ---- 行の組み立て ----

/**
 * 1 リクエスト分の読み取りをまとめたもの。Python は行ごとに lock やグローバル lock を
 * 読み直しているが、リクエスト中に変わらないので 1 回にしている。結果は同じ。
 */
type RowContext = {
  lock: Lock;
  active: Set<string>;
  archived: Set<string>;
  tracked: Set<string>;
  ignored: Set<string>;
  globalLock: Record<string, { source?: string }>;
};

function rowContext(lock: Lock): RowContext {
  return {
    lock,
    active: visibleInstalledNames(lock, activeDir()),
    archived: visibleInstalledNames(lock, archiveDir()),
    tracked: trackedSkills(lock),
    ignored: ignoredSkills(),
    globalLock: loadGlobalLock(),
  };
}

/** 返り値は Python と同じ [category, source] の並び。 */
function skillMetadata(ctx: RowContext, name: string): [string, string] {
  const custom = ctx.lock.custom?.skills ?? {};
  const external = ctx.lock.external ?? {};
  const globalMeta = ctx.globalLock[name];
  if (globalMeta && Object.keys(globalMeta).length > 0) {
    const source = globalMeta.source ?? "";
    const repoSource = ctx.lock.custom?.repo;
    if (source && source !== repoSource) return [source, "external"];
  }
  if (name in custom) {
    const meta = custom[name];
    return [
      (typeof meta === "string" ? "" : meta?.category) || "custom",
      "custom",
    ];
  }
  if (name in external)
    return [external[name]?.source || "external", "external"];
  if (ctx.ignored.has(name)) return ["ignored", "unmanaged"];
  return ["untracked", "untracked"];
}

export function skillDescription(lock: Lock, name: string): string {
  const custom = lock.custom?.skills ?? {};
  const external = lock.external ?? {};

  const meta = custom[name];
  const repoPath = typeof meta === "string" ? null : meta?.repoPath;
  if (repoPath) {
    const description = frontmatterDescription(
      resolveCatalogPath(`${repoPath}/SKILL.md`)
    );
    if (description) return description;
  }

  const localRepoPath = external[name]?.localRepoPath;
  if (localRepoPath) {
    const description = frontmatterDescription(
      resolveCatalogPath(`${localRepoPath}/SKILL.md`)
    );
    if (description) return description;
  }

  for (const base of [activeDir(), archiveDir()]) {
    const description = frontmatterDescription(join(base, name, "SKILL.md"));
    if (description) return description;
  }
  return "";
}

export function skillProjectionState(
  name: string,
  active: Set<string>,
  archived: Set<string>
): Selection {
  if (active.has(name)) return "active";
  if (archived.has(name)) return "archive";
  return "off";
}

function tristateSkillRow(ctx: RowContext, name: string): TristateRow {
  const [category, source] = skillMetadata(ctx, name);
  const selection = skillProjectionState(name, ctx.active, ctx.archived);
  return {
    name,
    category,
    description: skillDescription(ctx.lock, name),
    source,
    state: selection === "off" ? "missing" : selection,
    selection,
    can_activate:
      ctx.tracked.has(name) || ctx.active.has(name) || ctx.archived.has(name),
  };
}

export function splitTristateRows(
  lock: Lock,
  skillNames: Iterable<string>
): [TristateRow[], TristateRow[]] {
  const ctx = rowContext(lock);
  const mainRows: TristateRow[] = [];
  const archivedRows: TristateRow[] = [];
  for (const name of sortNames(skillNames)) {
    const row = tristateSkillRow(ctx, name);
    if (row.selection === "archive") archivedRows.push(row);
    else mainRows.push(row);
  }
  // active → off の順に並べ、同じ選択状態の中は名前順。JS の sort は仕様上安定なので
  // Python の sorted と同じ結果になる。
  const selectionOrder: Record<string, number> = { active: 0, off: 1 };
  mainRows.sort((a, b) => {
    const order =
      (selectionOrder[a.selection] ?? 99) - (selectionOrder[b.selection] ?? 99);
    if (order !== 0) return order;
    return compareLower(a.name, b.name);
  });
  archivedRows.sort((a, b) => compareLower(a.name, b.name));
  return [mainRows, archivedRows];
}

function compareLower(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

export function globalTristateRows(lock: Lock): [TristateRow[], TristateRow[]] {
  return splitTristateRows(lock, visibleGlobalSkillNames(lock));
}

export function skillRows(
  lock: Lock,
  checked?: Set<string>,
  names?: Set<string>
): SkillRow[] {
  const ctx = rowContext(lock);
  const checkedSet = checked ?? ctx.active;
  const nameSet = difference(
    names ?? allSkillNames(lock),
    hiddenGlobalSkills(lock)
  );

  // Python は (name not in checked, name) のタプル順。checked が先に来る。
  const ordered = sortNames(nameSet).sort((a, b) => {
    const left = checkedSet.has(a) ? 0 : 1;
    const right = checkedSet.has(b) ? 0 : 1;
    if (left !== right) return left - right;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return ordered.map((name) => {
    const [category, source] = skillMetadata(ctx, name);
    const state: SkillState = ctx.active.has(name)
      ? "active"
      : ctx.archived.has(name)
        ? "archive"
        : "missing";
    return {
      name,
      category,
      description: skillDescription(ctx.lock, name),
      source,
      state,
      checked: checkedSet.has(name),
    };
  });
}
