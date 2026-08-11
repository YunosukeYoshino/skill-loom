/**
 * 外部 skill（他リポジトリ由来）の source 単位の集計と更新確認。
 *
 * `bin/my-skills.py` の `external_*` 系ヘルパの移植。GitHub を叩く部分は
 * `github.ts` に寄せてあり、ここは lock を起点にした組み立てと並列化だけを持つ。
 *
 * 更新確認は source ごとではなく skill ごとに並べて一斉に投げる。source 単位で
 * 直列にすると、source が増えるほど一覧の表示が線形に遅くなる。
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
  externalCandidatesFile,
  externalUpdateCheckWorkers,
  projectDecksDir,
  skillsAddScript,
  skillsRemoveBin,
  skillsUpdateBin,
} from "./config";
import { ValueError } from "./errors";
import {
  cliSkillNeedsUpdate,
  clearGithubTreeShaCache,
  type ExternalCandidate,
  externalSkillCandidates,
  fetchRemoteSkillContentHash,
  HttpError,
  installedSkillContentHash,
  normalizeGithubSource,
} from "../infrastructure/github";
import {
  type Lock,
  loadGlobalLock,
  loadLock,
  removeIgnoredSkills,
  saveLock,
  sortNames,
  visibleInstalledNames,
} from "./inventory";
import { linkAgentSkillDirsMany } from "./projection";

// ---- 型 ----

export type ExternalSourceRow = {
  source: string;
  owner: string;
  repo: string;
  sourceUrl: string;
  skills: string[];
};

export type SourceUpdateStatus = {
  checked?: boolean;
  updatable?: string[];
  error?: string;
};

/** [source, name, skillPath] の 3 つ組。更新確認 1 件分の入力。 */
type UpdateTask = [string, string, string];

/** [source, name, hasUpdate, error]。Python の tuple をそのまま写している。 */
type UpdateResult = [string, string, boolean, string | null];

// ---- source の集計 ----

export function activeExternalSkillNames(lock: Lock): Set<string> {
  const active = visibleInstalledNames(lock, activeDir());
  const external = new Set(Object.keys(lock.external ?? {}));
  return new Set([...active].filter((name) => external.has(name)));
}

/** source ごとに skill をまとめる。並びは source の小文字比較で、skill 名は lock の名前順。 */
export function externalSourceSummary(lock: Lock): ExternalSourceRow[] {
  const sources = new Map<string, ExternalSourceRow>();
  for (const name of sortNames(Object.keys(lock.external ?? {}))) {
    const meta = lock.external?.[name] ?? {};
    const source = meta.source || "external";
    let row = sources.get(source);
    if (!row) {
      const index = source.indexOf("/");
      row = {
        source,
        owner: (index < 0 ? source : source.slice(0, index)) || source,
        repo: (index < 0 ? "" : source.slice(index + 1)) || source,
        sourceUrl: meta.sourceUrl ?? "",
        skills: [],
      };
      sources.set(source, row);
    }
    row.skills.push(name);
  }
  return [...sources.values()].sort((a, b) => {
    const left = a.source.toLowerCase();
    const right = b.source.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** 一覧に出すバッジ。確認していない source は空文字（バッジ自体を出さない）。 */
export function externalSourceStatusLabel(
  status: SourceUpdateStatus | undefined
): string {
  if (!status || Object.keys(status).length === 0) return "";
  if (status.error || !status.checked) return "確認失敗";
  const updatable = status.updatable ?? [];
  if (updatable.length > 0) return `更新あり ${updatable.length}`;
  return "最新";
}

// ---- 外部 CLI のコマンド ----

export function externalUpdateCommand(skillName: string): string[] {
  return [skillsUpdateBin(), "skills", "update", skillName, "-g", "-y"];
}

export function externalRemoveCommand(skillName: string): string[] {
  return [skillsRemoveBin(), "skills", "remove", skillName, "-g", "-y"];
}

/**
 * skill 名がそのまま CLI の argv に乗ってよいか。
 *
 * update / update-all は lock 由来の名前しか渡さないが、remove だけはリクエストの
 * 文字列を検証せずに渡していた（移行前も同じ）。`-` 始まりだと `skills remove` の
 * オプションとして解釈され、消す対象がずれる。実在の skill 名は `-` で始まらないので
 * ここで弾いても移行前に通っていた入力は落ちない。
 */
export function isArgvSafeSkillName(name: string): boolean {
  return name !== "" && !name.startsWith("-");
}

// ---- 更新確認 ----

function localContentHash(name: string): string {
  return installedSkillContentHash([activeDir(), archiveDir()], name);
}

/**
 * 候補 1 件に更新があるか。CLI の判定を優先し、無ければ内容ハッシュを比べる。
 * 候補側にハッシュが無ければ「更新なし」に倒す（誤って更新ボタンを出さない）。
 */
export async function skillHasRemoteUpdate(
  name: string,
  candidate: ExternalCandidate
): Promise<boolean> {
  const cliStatus = await cliSkillNeedsUpdate(name);
  if (cliStatus !== null) return cliStatus;
  const remoteHash = candidate.contentHash ?? "";
  const localHash = localContentHash(name);
  return Boolean(remoteHash && localHash && remoteHash !== localHash);
}

/** 確認対象は active な外部 skill だけ。off / archive は更新しても projection に出ない。 */
export function installedExternalUpdateTasks(
  lock: Lock,
  sourceFilter?: string | null
): UpdateTask[] {
  const normalized = sourceFilter ? normalizeGithubSource(sourceFilter) : null;
  const active = activeExternalSkillNames(lock);
  const tasks: UpdateTask[] = [];
  for (const [name, meta] of Object.entries(lock.external ?? {})) {
    if (!active.has(name)) continue;
    const source = meta.source ?? "";
    const skillPath = meta.skillPath ?? "";
    if (!source || !skillPath) continue;
    if (normalized && source !== normalized) continue;
    tasks.push([source, name, skillPath]);
  }
  return tasks;
}

/** lock の skillPath が古いとき、clone して見つけ直した実パスを書き戻す。 */
function updateSkillPathInLock(name: string, newPath: string): void {
  try {
    const lock = loadLock();
    if (lock.external?.[name]) {
      (lock.external[name] as { skillPath?: string }).skillPath = newPath;
      saveLock(lock);
      console.error(
        `Auto-healed skillPath for '${name}' to '${newPath}' in lock file`
      );
    }
  } catch (error) {
    console.error(
      `Error saving updated skillPath for ${name} to lock: ${error}`
    );
  }
}

function resolveAndUpdateSkillPath(
  name: string,
  source: string
): string | null {
  try {
    for (const candidate of externalSkillCandidates(source)) {
      if (candidate.name === name && candidate.path) {
        updateSkillPathInLock(name, candidate.path);
        return candidate.path;
      }
    }
  } catch (error) {
    console.error(
      `Failed to auto-heal path for skill '${name}' from '${source}': ${error}`
    );
  }
  return null;
}

export async function checkInstalledSkillRemoteUpdate(
  task: UpdateTask
): Promise<UpdateResult> {
  const [source, name] = task;
  let skillPath = task[2];
  try {
    const cliStatus = await cliSkillNeedsUpdate(name);
    if (cliStatus !== null) return [source, name, cliStatus, null];

    const ownerRepo = normalizeGithubSource(source);
    let remoteHash: string;
    try {
      remoteHash = await fetchRemoteSkillContentHash(ownerRepo, skillPath);
    } catch (error) {
      // 404 は「消えた」ではなく「リポジトリ内で移動した」ことが多い。clone して探し直す。
      if (!(error instanceof HttpError) || error.code !== 404) throw error;
      const newPath = resolveAndUpdateSkillPath(name, source);
      if (!newPath) throw error;
      skillPath = newPath;
      remoteHash = await fetchRemoteSkillContentHash(ownerRepo, skillPath);
    }
    const localHash = localContentHash(name);
    return [
      source,
      name,
      Boolean(remoteHash && localHash && remoteHash !== localHash),
      null,
    ];
  } catch (error) {
    return [
      source,
      name,
      false,
      error instanceof Error ? error.message : String(error),
    ];
  }
}

/** 並列度を絞って一斉に投げる。返す順は入力どおり。 */
export async function parallelCheckInstalledSkillUpdates(
  tasks: UpdateTask[]
): Promise<UpdateResult[]> {
  if (tasks.length === 0) return [];
  const workers = Math.min(externalUpdateCheckWorkers(), tasks.length);
  const results: UpdateResult[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await checkInstalledSkillRemoteUpdate(
          tasks[index] as UpdateTask
        );
      }
    })
  );
  return results;
}

export async function updatableSkillsForSource(
  lock: Lock,
  source: string,
  candidates: ExternalCandidate[]
): Promise<string[]> {
  const ownerRepo = normalizeGithubSource(source);
  const activeExternal = activeExternalSkillNames(lock);
  const installed = Object.entries(lock.external ?? {})
    .filter(
      ([name, meta]) => meta.source === ownerRepo && activeExternal.has(name)
    )
    .map(([name]) => name);

  const candidateByName = new Map(
    candidates.map((candidate) => [candidate.name, candidate])
  );
  const updatable: string[] = [];
  for (const name of sortNames(installed)) {
    const candidate = candidateByName.get(name) ?? { name };
    if (await skillHasRemoteUpdate(name, candidate)) updatable.push(name);
  }
  return updatable;
}

/** 更新できる skill 名と、確認そのものに失敗した source のメッセージ。 */
export async function collectUpdatableSkillNames(
  lock: Lock,
  sourceFilter?: string | null
): Promise<[string[], string[]]> {
  clearGithubTreeShaCache();
  if (externalCandidatesFile()) {
    const updatable: string[] = [];
    const errors: string[] = [];
    for (const row of externalSourceSummary(lock)) {
      const source = row.source;
      if (sourceFilter && source !== normalizeGithubSource(sourceFilter))
        continue;
      try {
        updatable.push(
          ...(await updatableSkillsForSource(
            lock,
            source,
            externalSkillCandidates(source)
          ))
        );
      } catch (error) {
        errors.push(
          `${source}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return [sortNames(new Set(updatable)), errors];
  }

  const results = await parallelCheckInstalledSkillUpdates(
    installedExternalUpdateTasks(lock, sourceFilter)
  );
  const updatable = sortNames(
    results
      .filter(([, , hasUpdate, error]) => hasUpdate && !error)
      .map(([, name]) => name)
  );
  const errors = results
    .filter(([, , , error]) => error)
    .map(([source, name, , error]) => `${source}/${name}: ${error}`);
  return [updatable, errors];
}

/**
 * source ごとの更新確認結果。
 *
 * source 内の skill が「全部」失敗したときだけ source を確認失敗にする。1 件でも
 * 取れていれば残りの結果は使える情報なので、source ごと落とさない。
 */
export async function collectExternalUpdateStatus(
  lock: Lock
): Promise<[Record<string, SourceUpdateStatus>, string[]]> {
  clearGithubTreeShaCache();
  const sources = externalSourceSummary(lock);
  const statusBySource: Record<string, SourceUpdateStatus> = {};
  for (const row of sources)
    statusBySource[row.source] = { checked: true, updatable: [] };

  if (externalCandidatesFile()) {
    const errors: string[] = [];
    for (const row of sources) {
      const source = row.source;
      try {
        const updatable = await updatableSkillsForSource(
          lock,
          source,
          externalSkillCandidates(source)
        );
        (statusBySource[source] as SourceUpdateStatus).updatable = updatable;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${source}: ${message}`);
        statusBySource[source] = {
          checked: false,
          error: message,
          updatable: [],
        };
      }
    }
    for (const status of Object.values(statusBySource))
      status.updatable = sortNames(status.updatable ?? []);
    return [statusBySource, errors];
  }

  const tasks = installedExternalUpdateTasks(lock);
  const results = await parallelCheckInstalledSkillUpdates(tasks);
  const errors: string[] = [];
  const sourceErrors = new Map<string, string[]>();
  for (const [source, name, hasUpdate, error] of results) {
    if (error) {
      const list = sourceErrors.get(source) ?? [];
      list.push(`${name}: ${error}`);
      sourceErrors.set(source, list);
      continue;
    }
    if (hasUpdate) statusBySource[source]?.updatable?.push(name);
  }
  for (const [source, sourceErrs] of sourceErrors) {
    const status = statusBySource[source];
    if (!status) continue;
    const totalForSource = tasks.filter(
      ([taskSource]) => taskSource === source
    ).length;
    if (totalForSource && sourceErrs.length >= totalForSource) {
      status.checked = false;
      status.updatable = [];
      status.error = sourceErrs.slice(0, 2).join("; ");
      errors.push(`${source}: ${status.error}`);
    }
  }
  for (const status of Object.values(statusBySource))
    status.updatable = sortNames(status.updatable ?? []);
  return [statusBySource, errors];
}

/**
 * update を走らせた後、まだ更新があるように見えるか。
 * 確認に失敗した場合も true を返す（「更新済み」と言い切らない側に倒す）。
 */
export async function externalSkillStillUpdatable(
  lock: Lock,
  name: string
): Promise<boolean> {
  const task = installedExternalUpdateTasks(lock).find(
    ([, taskName]) => taskName === name
  );
  if (!task) return false;
  const [, , hasUpdate, error] = await checkInstalledSkillRemoteUpdate(task);
  return Boolean(error) || hasUpdate;
}

export function formatExternalUpdateMessage(
  updated: string[],
  unchanged: string[],
  failed: string[],
  fetchErrors: string[] = []
): string {
  const parts: string[] = [];
  if (updated.length > 0) parts.push(`updated: ${updated.join(", ")}`);
  if (unchanged.length > 0)
    parts.push(`未反映(CLI最新扱い): ${unchanged.join(", ")}`);
  if (failed.length > 0) parts.push(`failed: ${failed.join(", ")}`);
  if (fetchErrors.length > 0)
    parts.push(`確認失敗: ${fetchErrors.slice(0, 3).join("; ")}`);
  return parts.length > 0 ? parts.join(" / ") : "update完了";
}

// ---- 管理から外す ----

/**
 * lock と project deck から skill を落とし、書き換えた deck の数を返す。
 *
 * lock だけ消して deck に残すと、その deck を install した時点で管理外の skill が
 * 復活する。両方を同じ操作で落とすのはそのため。lock の保存は呼び出し側の責任。
 */
// ---- 取り込み ----

/**
 * 外部 skill を実際に global へ install する。
 *
 * `--no-commit` を渡すのは、lock への登録と commit を呼び出し側でまとめて行うため。
 * timeout は 1 skill あたり 180 秒。まとめて選ぶほど当然長くかかる。
 *
 * `spawnSync` ではなく非同期で待つ。install は分単位でかかることがあり、同期で待つと
 * Bun の単一スレッドごと止まって、他のリクエストが 409 すら返せなくなる。
 */
export async function runExternalInstall(
  source: string,
  selected: Set<string>
): Promise<void> {
  const command = ["bash", skillsAddScript(), source, "--no-commit"];
  for (const name of sortNames(selected)) command.push("--skill", name);
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000 * Math.max(1, selected.size),
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `Command '${command.join(" ")}' returned non-zero exit status ${exitCode}.`
    );
  }
  linkAgentSkillDirsMany(selected);
}

/**
 * install せずに lock へだけ載せる。「deck にだけ追加」の経路。
 *
 * source に無い名前は黙って足さず ValueError にする。存在しない skill が deck に
 * 載ると、その deck を install した時点で必ず unresolved で止まる。
 */
export function addExternalToLock(
  source: string,
  selected: Set<string>,
  candidates: ExternalCandidate[]
): void {
  const ownerRepo = normalizeGithubSource(source);
  const candidateByName = new Map(
    candidates.map((candidate) => [candidate.name, candidate])
  );
  const lock = loadLock();
  const external = (lock.external ??= {});
  const custom = lock.custom?.skills ?? {};

  for (const name of sortNames(selected)) {
    if (name in custom) continue;
    const candidate = candidateByName.get(name);
    if (!candidate) throw new ValueError(`Skill not found in source: ${name}`);
    external[name] = {
      source: ownerRepo,
      sourceUrl: `https://github.com/${ownerRepo}.git`,
      skillPath: candidate.path ?? `skills/${name}/SKILL.md`,
    };
  }
  saveLock(lock);
  removeIgnoredSkills(selected);
}

/**
 * install 済みの外部 skill を管理対象として lock に載せ、[新しい lock, ignore 解除数] を返す。
 *
 * skills CLI 側の lock に実際の取得元が残っているので、そちらを優先して写す。
 * 手元に無ければ source から組み立てた既定値へ倒す。
 */
export function registerInstalledExternalSelection(
  source: string,
  selected: Set<string>
): [Lock, number] {
  const ownerRepo = normalizeGithubSource(source);
  const lock = loadLock();
  const external = (lock.external ??= {});
  const custom = lock.custom?.skills ?? {};
  const globalSkills = loadGlobalLock();

  for (const name of sortNames(selected)) {
    if (name in custom) continue;
    const globalMeta = globalSkills[name] ?? {};
    external[name] = {
      source: ownerRepo,
      sourceUrl: globalMeta.sourceUrl ?? `https://github.com/${ownerRepo}.git`,
      skillPath: globalMeta.skillPath ?? `skills/${name}/SKILL.md`,
    };
  }
  saveLock(lock);
  const removedIgnored = removeIgnoredSkills(selected);
  return [loadLock(), removedIgnored];
}

export function removeExternalSkillFromManagement(
  lock: Lock,
  skill: string,
  decksDir = projectDecksDir()
): number {
  delete lock.external?.[skill];
  let removedFromDecks = 0;
  let entries: string[];
  try {
    entries = readdirSync(decksDir, { recursive: true }) as string[];
  } catch {
    return removedFromDecks;
  }
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const path = join(decksDir, entry);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const deck = JSON.parse(readFileSync(path, "utf-8")) as {
      skills?: string[];
    };
    const skills = deck.skills ?? [];
    if (!skills.includes(skill)) continue;
    deck.skills = skills.filter((name) => name !== skill);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(deck, null, 2)}\n`);
    renameSync(tmp, path);
    removedFromDecks += 1;
  }
  return removedFromDecks;
}
