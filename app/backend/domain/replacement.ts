/**
 * Skill Replacement — 同じ名前の既存 skill を、別 source の skill へ入れ替える（ADR 0003）。
 *
 * 名前は変わらないので、deck の所属はそのまま残る。Active/Archive の状態は
 * 退避前に覚えておき、新しい skill の install 後に同じ状態へ戻す。Off の既存は
 * 手元に実体が無いので退避も install もせず、lock の取得元だけ付け替える。
 *
 * 手順は「journal を書く → 既存を退避 → 新しい方を install → commit → 後始末」。
 * commit より前に失敗したら退避した実体と lock のエントリを戻し、後なら後始末を
 * 最後までやり切る。途中でプロセスが落ちても、起動時に journal から同じ判断で続きを行う。
 *
 * 退避所は archive 直下の `.replace/<id>/`。同じ FS 上なので rename で済み、
 * dot で始まるので Projection からは見えない。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { activeDir, archiveDir } from "./config";
import { ValueError } from "./errors";
import {
  assertValidExternalSkillName,
  registerInstalledExternalSelection,
  type ResolvedExternalCandidate,
  retargetExternalEntries,
  runExternalInstall,
} from "./external";
import {
  type ExternalSkillMeta,
  type GlobalLockEntry,
  loadGlobalLock,
  loadLock,
  saveLock,
} from "./inventory";
import {
  archiveInstalledSkills,
  linkAgentSkillDirs,
  movePath,
  setCliLockEntries,
  trashPath,
  unlinkAgentSkillDirs,
} from "./projection";

type ReplacedState = "active" | "archive";

/** 置き換える 1 件ぶんの、元に戻すための記録。lock のエントリは無ければ null。 */
type ReplacedRow = {
  name: string;
  state: ReplacedState;
  lockEntry: ExternalSkillMeta | null;
  cliLockEntry: GlobalLockEntry | null;
};

type Journal = {
  version: 1;
  phase: "prepared" | "committed";
  rows: ReplacedRow[];
};

export type ReplacementHandle = { dir: string; rows: ReplacedRow[] };

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function replaceRoot(): string {
  return join(archiveDir(), ".replace");
}

function isPlaced(name: string): boolean {
  return present(join(activeDir(), name)) || present(join(archiveDir(), name));
}

function stateOf(name: string): ReplacedState {
  const active = present(join(activeDir(), name));
  const archived = present(join(archiveDir(), name));
  // どちらを残すべきか決められない。退避・巻き戻しの前提が崩れるので入口で止める。
  if (active && archived)
    throw new ValueError(`${name} is in both Active and Archive`);
  if (active) return "active";
  if (archived) return "archive";
  throw new ValueError(`${name} is not installed`);
}

function dirOf(state: ReplacedState): string {
  return state === "active" ? activeDir() : archiveDir();
}

function writeJournal(
  handle: ReplacementHandle,
  phase: Journal["phase"]
): void {
  const journal: Journal = { version: 1, phase, rows: handle.rows };
  const path = join(handle.dir, "journal.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** 既存の実体を退避所へ移し、Inventory Lock から外す。何か動かす前に journal を書く。 */
export function setAsideForReplacement(names: string[]): ReplacementHandle {
  for (const name of names) assertValidExternalSkillName(name);
  const lock = loadLock();
  const cliLock = loadGlobalLock();
  const rows = names.map((name) => ({
    name,
    state: stateOf(name),
    lockEntry: lock.external?.[name] ?? null,
    cliLockEntry: cliLock[name] ?? null,
  }));

  mkdirSync(replaceRoot(), { recursive: true });
  const handle = { dir: mkdtempSync(join(replaceRoot(), "r-")), rows };
  writeJournal(handle, "prepared");

  for (const { name, state } of rows) {
    if (state === "active") unlinkAgentSkillDirs(name);
    movePath(join(dirOf(state), name), join(handle.dir, name));
    if (lock.external) delete lock.external[name];
  }
  saveLock(lock);
  return handle;
}

/** 新しい skill が入ったことを確かめた時点。以降は巻き戻さず後始末を進める。 */
export function commitReplacement(handle: ReplacementHandle): void {
  writeJournal(handle, "committed");
}

/**
 * commit 前の失敗。新しく入りかけた分を捨て、退避した実体と lock のエントリを戻す。
 * 戻し先が既に埋まっていれば上書きせず、退避所を残して警告文を返す。
 */
export function rollbackReplacement(handle: ReplacementHandle): string {
  const warnings = handle.rows.map((row) => restoreFiles(handle, row));
  const lock = loadLock();
  const external = (lock.external ??= {});
  for (const { name, lockEntry } of handle.rows) {
    if (lockEntry) external[name] = lockEntry;
    else delete external[name];
  }
  saveLock(lock);
  warnings.push(
    setCliLockEntries(
      Object.fromEntries(handle.rows.map((row) => [row.name, row.cliLockEntry]))
    )
  );
  if (!handle.rows.some((row) => present(join(handle.dir, row.name))))
    trashPath(handle.dir);
  return warnings.filter(Boolean).join("\n");
}

/** 1 件ぶんの実体を置き換え前へ戻す。戻せなければ警告文を返す。 */
function restoreFiles(handle: ReplacementHandle, row: ReplacedRow): string {
  const { name, state } = row;
  const stashed = join(handle.dir, name);
  // 退避前に止まった Active の既存は、まだ activeDir に居る。それは捨てない。
  if (state !== "active" || present(stashed)) {
    unlinkAgentSkillDirs(name);
    trashPath(join(activeDir(), name));
  }
  const base = dirOf(state);
  if (!present(stashed)) return "";
  if (present(join(base, name)))
    return `置き換え前の ${name} を戻せませんでした（戻し先が使用中）: ${stashed}`;
  movePath(stashed, join(base, name));
  if (state === "active") linkAgentSkillDirs(name);
  return "";
}

/**
 * commit 後。Archive にあった分は新しい skill も Archive へ送り、退避所を捨てる。
 * 起動時の復旧からも呼ぶので、既に済んだ手順は飛ばす。戻り値は警告文。
 */
export function finishReplacement(handle: ReplacementHandle): string {
  const archived = handle.rows
    .filter(
      (row) => row.state === "archive" && present(join(activeDir(), row.name))
    )
    .map((row) => row.name);
  const warning = archiveInstalledSkills(new Set(archived));
  trashPath(handle.dir);
  return warning;
}

/**
 * 退避 → install → commit → 後始末 を通す。install が投げたら巻き戻してから投げ直す。
 * 後始末の失敗は投げない（新しい skill は入っている）。journal が残り、次回起動時に続きを行う。
 */
export async function replaceWhileInstalling<T>(
  names: string[],
  install: () => Promise<T>
): Promise<[T, string]> {
  const handle = setAsideForReplacement(names);
  let installed: T;
  try {
    installed = await install();
  } catch (error) {
    const warning = rollbackReplacement(handle);
    if (!warning) throw error;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} / ${warning}`
    );
  }
  commitReplacement(handle);
  try {
    return [installed, finishReplacement(handle)];
  } catch (error) {
    return [
      installed,
      `置き換えの後始末が途中で止まりました（次回起動時に再開）: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/**
 * 選んだ候補を取り込む。置き換える行のうち手元に実体があるものは退避してから入れ、
 * Off の既存は lock の付け替えだけで済ませる。戻り値は [ignore 解除数, 警告文]。
 */
export async function installExternalSelection(
  source: string,
  resolved: ResolvedExternalCandidate[]
): Promise<[number, string]> {
  const off = resolved.filter(
    (row) => row.conflict && !isPlaced(row.deployName)
  );
  const toInstall = resolved.filter((row) => !off.includes(row));
  const placed = toInstall
    .filter((row) => row.conflict)
    .map((row) => row.deployName);
  const install = async () => {
    if (toInstall.length === 0) return 0;
    const names = new Set(toInstall.map((row) => row.deployName));
    await runExternalInstall(source, names, toInstall);
    return registerInstalledExternalSelection(source, names, toInstall)[1];
  };
  const [unignored, warning] =
    placed.length === 0
      ? [await install(), ""]
      : await replaceWhileInstalling(placed, install);
  retargetExternalEntries(source, off);
  return [unignored, warning];
}

function readJournal(dir: string): Journal | null {
  try {
    const journal = JSON.parse(
      readFileSync(join(dir, "journal.json"), "utf8")
    ) as Journal;
    return journal.version === 1 && Array.isArray(journal.rows)
      ? journal
      : null;
  } catch {
    return null;
  }
}

/** 起動時に、途中で止まった置き換えを journal の phase に従って片付ける。戻り値は警告文。 */
export function recoverPendingReplacements(): string {
  const root = replaceRoot();
  if (!existsSync(root)) return "";
  const warnings: string[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    const journal = readJournal(dir);
    if (!journal) {
      warnings.push(`置き換えの記録を読めませんでした: ${dir}`);
      continue;
    }
    const handle = { dir, rows: journal.rows };
    warnings.push(
      journal.phase === "committed"
        ? finishReplacement(handle)
        : rollbackReplacement(handle)
    );
  }
  return warnings.filter(Boolean).join("\n");
}
