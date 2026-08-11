/**
 * custom skill（このリポジトリ由来）の drift 検出と、リポジトリからの上書き。
 *
 * 外部 skill と違ってリモートを見る必要はなく、`repoPath` の実体と展開済みの
 * コピーをファイル単位のハッシュで突き合わせるだけ。SKILL.md だけは差分そのものを
 * 返す（UI で中身を確かめてから update を押すため）。
 */

import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import type { CustomUpdatable } from "../../shared/api-types";
import { activeDir, archiveDir } from "./config";
import { resolveCatalogPath } from "./catalogPaths";
import { splitLines, unifiedDiff } from "./diff";
import { skillFileHash } from "../infrastructure/github";
import { type Lock, type SkillState, sortNames } from "./inventory";
import { linkAgentSkillDirs } from "./projection";

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** lock の `repoPath` を実体のあるパスに解決する。無ければ null。 */
export function customSkillRepoDir(lock: Lock, name: string): string | null {
  const meta = lock.custom?.skills?.[name];
  // lock の値が文字列のこともある。移行前も dict 以外は repoPath なしとして扱う。
  const repoPath = typeof meta === "string" ? null : meta?.repoPath;
  if (!repoPath) return null;
  const path = resolveCatalogPath(repoPath);
  return exists(path) ? path : null;
}

/** 展開先。active を先に見るので、両方にあれば active 扱いになる。 */
export function installedCustomSkillLocation(
  name: string
): [string | null, SkillState] {
  const active = join(activeDir(), name);
  if (exists(active)) return [active, "active"];
  const archived = join(archiveDir(), name);
  if (exists(archived)) return [archived, "archive"];
  return [null, "missing"];
}

/** root 配下の全ファイルを、root からの相対パスで引ける形にする。 */
export function skillTreeFileMap(root: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!exists(root)) return files;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // symlink の先へは降りない（`rglob` も既定では辿らない）。ただし
      // ファイルを指す symlink は 1 件として数える。`is_file()` と同じ扱い。
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || isFileFollowingLinks(path)) {
        files.set(relative(root, path).split(sep).join("/"), path);
      }
    }
  };
  walk(root);
  return files;
}

/** SKILL.md だけの unified diff。同じなら空文字。 */
export function skillMdUnifiedDiff(
  installedDir: string,
  repoDir: string
): string {
  const installed = join(installedDir, "SKILL.md");
  const repo = join(repoDir, "SKILL.md");
  if (!exists(installed) && !exists(repo)) return "";
  const left = exists(installed) ? splitLines(readText(installed)) : [];
  const right = exists(repo) ? splitLines(readText(repo)) : [];
  if (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  )
    return "";
  return unifiedDiff(
    left,
    right,
    `installed/${basename(installedDir)}/SKILL.md`,
    `repo/${basename(repoDir)}/SKILL.md`
  );
}

function isFileFollowingLinks(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // 壊れた symlink。`is_file()` も False を返す。
    return false;
  }
}

function readText(path: string): string {
  // 不正なバイト列は U+FFFD に落とす。移行前の errors="replace" と同じ。
  return new TextDecoder("utf-8").decode(readFileSync(path));
}

function basename(path: string): string {
  const parts = path.split(sep);
  return parts[parts.length - 1] ?? path;
}

/** 1 件分の drift。差分が無ければ null。 */
export function customSkillDrift(
  lock: Lock,
  name: string
): CustomUpdatable | null {
  const repoDir = customSkillRepoDir(lock, name);
  const [installedDir, state] = installedCustomSkillLocation(name);
  if (repoDir === null || installedDir === null) return null;

  const repoFiles = skillTreeFileMap(repoDir);
  const installedFiles = skillTreeFileMap(installedDir);
  const changed: string[] = [];
  for (const rel of sortNames(
    new Set([...repoFiles.keys(), ...installedFiles.keys()])
  )) {
    const repoHash = repoFiles.has(rel)
      ? skillFileHash(repoFiles.get(rel) as string)
      : "";
    const installedHash = installedFiles.has(rel)
      ? skillFileHash(installedFiles.get(rel) as string)
      : "";
    if (repoHash !== installedHash) changed.push(rel);
  }
  if (changed.length === 0) return null;

  const meta = lock.custom?.skills?.[name];
  return {
    name,
    state,
    repoPath: typeof meta === "string" ? "" : (meta?.repoPath ?? ""),
    skillDiff: skillMdUnifiedDiff(installedDir, repoDir),
    otherChangedFiles: changed.filter((rel) => rel !== "SKILL.md"),
  };
}

export function collectCustomUpdatable(lock: Lock): CustomUpdatable[] {
  const rows: CustomUpdatable[] = [];
  for (const name of sortNames(Object.keys(lock.custom?.skills ?? {}))) {
    const drift = customSkillDrift(lock, name);
    if (drift) rows.push(drift);
  }
  return rows;
}

/**
 * 展開済みのコピーをリポジトリの内容で置き換える。更新した名前を返す。
 *
 * 展開先は今いる場所（active / archive）を保つ。archive のものを active へ
 * 引き上げてしまうと、update しただけで projection が変わる。
 */
export function updateCustomFromRepo(names: Set<string>, lock: Lock): string[] {
  const updated: string[] = [];
  for (const name of sortNames(names)) {
    const repoDir = customSkillRepoDir(lock, name);
    const [installedDir, state] = installedCustomSkillLocation(name);
    if (repoDir === null)
      throw new Error(`custom skill source not found: ${name}`);
    if (installedDir === null)
      throw new Error(`custom skill is not installed: ${name}`);

    const parent = state === "active" ? activeDir() : archiveDir();
    mkdirSync(parent, { recursive: true });
    const dst = join(parent, name);
    // ここだけはゴミ箱ではなく直接消す（移行前も rmtree）。捨てるのはリポジトリから
    // 作り直せる複製なので、update のたびにゴミ箱へ積むほうが害になる。
    if (exists(dst)) rmSync(dst, { recursive: true, force: true });
    // dereference は Python の copytree(symlinks=False) 相当。
    cpSync(repoDir, dst, { recursive: true, dereference: true });
    if (state === "active") linkAgentSkillDirs(name);
    updated.push(name);
  }
  return updated;
}
