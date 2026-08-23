/**
 * draft skill（`/new-skill` が `drafts/skills/{category}/{name}/` に置くもの）の
 * 一覧と、正式配置への昇格。
 *
 * 昇格は「コピー → lock 登録 → draft を捨てる」の順で、途中で失敗しても draft が
 * 残るようにしてある。先に draft を消すと、コピーに失敗したときに復元できない。
 */

import { cpSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { SkillRow } from "../../shared/api-types";
import { catalogRoot, draftSkillsDir } from "./config";
import { resolveCatalogPath } from "./catalogPaths";
import { ValueError } from "./errors";
import { frontmatterName } from "../infrastructure/github";
import {
  frontmatterDescription,
  type Lock,
  loadLock,
  saveLock,
  sortNames,
} from "./inventory";
import { trashPath } from "./projection";

export type DraftCandidate = {
  name: string;
  category: string;
  repoPath: string;
  description: string;
};

/**
 * 既に正式登録済み、または配置先が埋まっている draft。呼び出し側は 409 を返し、
 * force 付きで押し直させる。名前は確認パネルにそのまま出る。
 */
export class DraftConflictError extends ValueError {
  readonly names: string[];

  constructor(names: string[]) {
    super(`Already promoted: ${names.join(", ")}`);
    this.names = names;
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

/** `sortNames` と同じ code point 順の比較。 */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * frontmatter の name をそのままディレクトリ名として使ってよいか。
 *
 * `promoteDrafts` は昇格先を `skills/{category}/{name}/` と組み立てるので、`..` や
 * `/` を含む name を通すとリポジトリの外へ書き出せてしまう（移行前も同じだった）。
 * skill 名は英小文字・数字・ハイフンだけと決まっているので、ここで弾いても
 * 移行前に通っていた draft は落ちない。弾いたときはディレクトリ名で代用する。
 */
function isSafeSkillDirName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  return !/[/\\\0]/.test(name);
}

/** 壊れた symlink は `exists` では拾えないので別に見る。 */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * `drafts/skills/*​/*​/SKILL.md` を拾う。frontmatter に name が無い、または
 * ディレクトリ名として使えない場合はディレクトリ名で代用する。
 *
 * 並びは移行前の `sorted(Path.glob(...))` に合わせて category → ディレクトリ名の
 * 順で比べる。パス文字列そのものを比べると、`eng` と `eng-x` のように片方が
 * もう片方の接頭辞になったとき区切りの `/` (0x2F) と `-` (0x2D) の大小で逆転する。
 */
export function draftSkillCandidates(): DraftCandidate[] {
  const draftsRoot = draftSkillsDir();
  if (!exists(draftsRoot)) return [];

  const found: { category: string; dirName: string }[] = [];
  for (const category of readdirSync(draftsRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = join(draftsRoot, category.name);
    for (const skill of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      if (exists(join(categoryDir, skill.name, "SKILL.md"))) {
        found.push({ category: category.name, dirName: skill.name });
      }
    }
  }
  found.sort((left, right) =>
    left.category === right.category
      ? compareCodePoints(left.dirName, right.dirName)
      : compareCodePoints(left.category, right.category)
  );

  return found.map(({ category, dirName }) => {
    const skillDir = join(draftsRoot, category, dirName);
    const declared = frontmatterName(join(skillDir, "SKILL.md"));
    return {
      name: isSafeSkillDirName(declared) ? declared : dirName,
      category,
      repoPath: relative(catalogRoot(), skillDir).split(sep).join("/"),
      description: frontmatterDescription(join(skillDir, "SKILL.md")),
    };
  });
}

export function draftSkillMap(): Map<string, DraftCandidate> {
  return new Map(
    draftSkillCandidates().map((candidate) => [candidate.name, candidate])
  );
}

/** 一覧の行。既に custom 登録済みの名前は draft として出さない。 */
export function draftRows(lock: Lock): SkillRow[] {
  const custom = lock.custom?.skills ?? {};
  return draftSkillCandidates()
    .filter((candidate) => !(candidate.name in custom))
    .map((candidate) => ({
      name: candidate.name,
      category: candidate.category,
      description: candidate.description,
      source: candidate.repoPath,
      state: "draft",
      checked: false,
    }));
}

export function draftConflicts(
  selected: Set<string>,
  drafts: Map<string, DraftCandidate>,
  custom: Record<string, unknown>
): string[] {
  const conflicts: string[] = [];
  for (const name of sortNames(selected)) {
    const draft = drafts.get(name) as DraftCandidate;
    const dst = resolveCatalogPath(`skills/${draft.category}/${name}`);
    if (name in custom || exists(dst)) conflicts.push(name);
  }
  return conflicts;
}

/**
 * draft を `skills/{category}/{name}/` へ移し、lock に custom として登録する。
 *
 * 昇格した名前・書き込み後の lock・commit 対象の Catalog 内パスを返す。
 * パス組み立てに lock の内部構造が必要なので、呼び出し側で作らせない。
 */
export function promoteDrafts(
  selected: Set<string>,
  force = false
): [string[], Lock, string[]] {
  if (selected.size === 0) throw new ValueError("draftを選択してください");

  const drafts = draftSkillMap();
  const missing = sortNames([...selected].filter((name) => !drafts.has(name)));
  if (missing.length > 0)
    throw new ValueError(`Unknown drafts: ${missing.join(", ")}`);

  const lock = loadLock();
  lock.custom ??= {};
  lock.custom.skills ??= {};
  const custom = lock.custom.skills;
  const promoted: string[] = [];
  const commitPaths: string[] = [];

  const conflicts = draftConflicts(selected, drafts, custom);
  if (conflicts.length > 0 && !force) throw new DraftConflictError(conflicts);

  for (const name of sortNames(selected)) {
    const draft = drafts.get(name) as DraftCandidate;
    const category = draft.category;
    const src = resolveCatalogPath(draft.repoPath);
    const dst = resolveCatalogPath(`skills/${category}/${name}`);
    if (!exists(src)) throw new Error(`draft source not found: ${src}`);
    mkdirSync(join(dst, ".."), { recursive: true });
    if (exists(dst) || isSymlink(dst)) {
      if (!force) throw new DraftConflictError([name]);
      trashPath(dst);
    }
    // dereference は Python の copytree(symlinks=False) 相当。
    cpSync(src, dst, { recursive: true, dereference: true });
    custom[name] = { repoPath: `skills/${category}/${name}`, category };
    promoted.push(name);
    commitPaths.push(dst, src);
  }

  saveLock(lock);
  // draft を捨てるのは lock を書いたあと。先に捨てると失敗時に戻せない。
  for (const name of promoted)
    trashPath(
      resolveCatalogPath((drafts.get(name) as DraftCandidate).repoPath)
    );
  return [promoted, lock, commitPaths];
}
