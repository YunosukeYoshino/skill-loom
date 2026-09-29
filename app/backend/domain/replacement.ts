/**
 * Skill Replacement — 同じ名前の既存 skill を、別 source の skill へ入れ替える（ADR 0003）。
 *
 * 名前は変わらないので、deck の所属はそのまま残る。Active/Archive の状態は
 * 退避前に覚えておき、新しい skill の install 後に同じ状態へ戻す。
 *
 * 手順は「既存を退避 → 新しい方を install → 後始末」。install が失敗したら
 * 退避した実体と lock を丸ごと戻す。既存を先に消してしまうと、失敗時に何も残らない。
 */

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeDir, archiveDir, globalLockFile, lockFile } from "./config";
import { loadLock, saveLock } from "./inventory";
import {
  archiveInstalledSkills,
  deregisterFromCliLock,
  linkAgentSkillDirs,
  movePath,
  trashPath,
  unlinkAgentSkillDirs,
} from "./projection";

type ReplacedState = "active" | "archive" | "off";

export type ReplacementHandle = {
  stashDir: string;
  skills: Array<{ name: string; state: ReplacedState }>;
  lockText: string | null;
  cliLockText: string | null;
};

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function stateOf(name: string): ReplacedState {
  if (present(join(activeDir(), name))) return "active";
  if (present(join(archiveDir(), name))) return "archive";
  return "off";
}

function dirOf(state: ReplacedState): string | null {
  if (state === "active") return activeDir();
  if (state === "archive") return archiveDir();
  return null;
}

/** 既存の実体を一時ディレクトリへ移し、Inventory Lock から外す。 */
export function setAsideForReplacement(names: string[]): ReplacementHandle {
  const handle: ReplacementHandle = {
    stashDir: mkdtempSync(join(tmpdir(), "skill-loom-replace-")),
    skills: [],
    lockText: readText(lockFile()),
    cliLockText: readText(globalLockFile()),
  };
  const lock = loadLock();
  for (const name of names) {
    const state = stateOf(name);
    handle.skills.push({ name, state });
    const base = dirOf(state);
    if (state === "active") unlinkAgentSkillDirs(name);
    if (base) movePath(join(base, name), join(handle.stashDir, name));
    if (lock.external) delete lock.external[name];
  }
  saveLock(lock);
  return handle;
}

/** install が失敗したとき。新しく入りかけた分を捨て、退避した実体と lock を戻す。 */
export function rollbackReplacement(handle: ReplacementHandle): void {
  for (const { name, state } of handle.skills) {
    unlinkAgentSkillDirs(name);
    for (const base of [activeDir(), archiveDir()]) trashPath(join(base, name));
    const base = dirOf(state);
    if (base) movePath(join(handle.stashDir, name), join(base, name));
    if (state === "active") linkAgentSkillDirs(name);
  }
  if (handle.lockText !== null) writeFileSync(lockFile(), handle.lockText);
  if (handle.cliLockText !== null)
    writeFileSync(globalLockFile(), handle.cliLockText);
  trashPath(handle.stashDir);
}

/**
 * install が済んだあと。新しい skill を元の状態（Archive / Off）へ合わせ、退避分を捨てる。
 * 戻り値は CLI lock を書き換えられなかったときの警告文。
 */
export function finishReplacement(handle: ReplacementHandle): string {
  const byState = (state: ReplacedState) =>
    new Set(
      handle.skills.filter((row) => row.state === state).map((row) => row.name)
    );
  const warnings = [archiveInstalledSkills(byState("archive"))];
  const off = byState("off");
  for (const name of off) {
    unlinkAgentSkillDirs(name);
    trashPath(join(activeDir(), name));
  }
  warnings.push(deregisterFromCliLock(off));
  trashPath(handle.stashDir);
  return warnings.filter(Boolean).join("\n");
}
