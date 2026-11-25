/**
 * External Skill の一括更新。計画（読むだけ）と適用（書く）を分ける。
 *
 * 計画は source ごとに上流 repo を 1 回だけ blob なしで clone し、入っている tree
 * （CLI lock の skillFolderHash、無ければピンの commit）と HEAD の tree を比べる。
 * 適用は source ごとに `skills add` を 1 回まとめて呼び、別名で入れた skill だけ
 * 上流名で入れ直す。入った tree が計画した HEAD と一致した skill だけピンを進め、
 * それ以外は退避しておいた中身と CLI lock のエントリへ戻す。
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeDir,
  externalUpdateCheckWorkers,
  globalLockFile,
} from "./config";
import {
  type GlobalLockEntry,
  type Lock,
  loadGlobalLock,
  sortNames,
} from "./inventory";
import { activeExternalSkillNames } from "./external";
import {
  advanceExternalPins,
  type LockPin,
  loadLockPins,
  pinEntry,
  pinTimestamp,
} from "./lock-pins";
import {
  installCommands,
  isAliasedExternal,
  reinstallAliasedExternal,
  runSkillsCli,
  trashPath,
} from "./projection";
import {
  normalizeGithubSource,
  skillFileHash,
  skillMdFolderPath,
} from "../infrastructure/github";
import {
  UpstreamClone,
  type UpstreamFileChange,
} from "../infrastructure/upstream-git";

export type BulkUpdateFailureKind =
  | "fetch"
  | "missing-path"
  | "install"
  | "verify"
  | "rolled-back"
  | "pins-write";

export type BulkUpdateFailure = {
  kind: BulkUpdateFailureKind;
  message: string;
};

/** 差分の起点。CLI lock の tree が一番確か。無ければピン、どちらも無ければ不明。 */
export type UpdateBaseline = "installed" | "pin" | "unknown";

export type PlannedSkillUpdate = {
  name: string;
  state: "update";
  source: string;
  upstreamName: string;
  aliased: boolean;
  skillPath: string;
  pin: string | null;
  head: string;
  headTree: string;
  baseline: UpdateBaseline;
  /** ピンから HEAD までに skill のフォルダへ入った commit の数。ピンが無い・届かないときは null。 */
  commits: number | null;
  /** 起点の tree が clone に無いときは null（何が変わるか言い切れない）。 */
  files: UpstreamFileChange[] | null;
  risky: string[];
};

export type SkillPlanEntry =
  | PlannedSkillUpdate
  | { name: string; state: "current" }
  | { name: string; state: "skipped"; reason: "vendor" }
  | { name: string; state: "failed"; failure: BulkUpdateFailure };

export type SourcePlan = {
  source: string;
  sourceUrl: string;
  head: string | null;
  /** この source の skill が今ピンしている commit（重複なし）。 */
  pins: string[];
  skills: SkillPlanEntry[];
};

export type ExternalBulkUpdatePlan = { sources: SourcePlan[] };

export type ExternalBulkUpdateSession = {
  plan: ExternalBulkUpdatePlan;
  dispose(): void;
};

export type BulkUpdateSkillOutcome =
  | { name: string; source: string; outcome: "updated"; commit: string }
  | { name: string; source: string; outcome: "held"; reason: "risky" }
  | {
      name: string;
      source: string;
      outcome: "failed";
      failure: BulkUpdateFailure;
    };

export type BulkUpdateOptions = {
  /** スクリプトなど実行されうるファイルが変わった skill も更新する。既定では保留にする。 */
  includeRisky?: boolean;
  /** 途中で失敗したとき、成功した分を残すか、全部戻すか。 */
  onFailure?: "keep-successes" | "rollback-all";
  run?: (cmd: string[]) => void;
};

const RISKY_EXTENSIONS =
  /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|mts|cts|rb|pl|php|ps1|bat|cmd|exe|bin)$/i;
const RISKY_SEGMENTS = /(^|\/)(scripts|bin|hooks)\//;
const EXECUTABLE_MODES = new Set(["100755", "120000"]);

/** 読み込まれるだけでなく実行されうるファイル。人が差分を見るまで自動では入れない。 */
function isRiskyChange(change: UpstreamFileChange): boolean {
  if (change.status === "D") return false;
  return (
    RISKY_EXTENSIONS.test(change.path) ||
    RISKY_SEGMENTS.test(change.path) ||
    EXECUTABLE_MODES.has(change.mode)
  );
}

type PlanTarget = {
  name: string;
  upstreamName: string;
  skillPath: string;
  vendor: boolean;
};

type SourceGroup = { source: string; sourceUrl: string; targets: PlanTarget[] };

function sameSource(a: string | undefined, b: string): boolean {
  try {
    return (
      normalizeGithubSource(a ?? "").toLowerCase() ===
      normalizeGithubSource(b).toLowerCase()
    );
  } catch {
    return false;
  }
}

function targetGroup(
  groups: Map<string, SourceGroup>,
  source: string,
  sourceUrl: string | undefined
): SourceGroup {
  const existing = groups.get(source);
  if (existing) return existing;
  const group: SourceGroup = {
    source,
    sourceUrl: sourceUrl ?? `https://github.com/${source}.git`,
    targets: [],
  };
  groups.set(source, group);
  return group;
}

type LocatedTarget = PlanTarget & { source: string; sourceUrl?: string };

function locateTarget(lock: Lock, name: string): LocatedTarget | null {
  const meta = lock.external?.[name] ?? {};
  if (!meta.source || !meta.skillPath) return null;
  return {
    name,
    upstreamName: meta.installSkill ?? name,
    skillPath: meta.skillPath,
    vendor: name in (lock.vendor ?? {}),
    source: meta.source,
    sourceUrl: meta.sourceUrl,
  };
}

function inSourceFilter(
  lock: Lock,
  name: string,
  sourceFilter: string | null
): boolean {
  return (
    sourceFilter === null ||
    sameSource(lock.external?.[name]?.source ?? "", sourceFilter)
  );
}

function groupBySource(
  lock: Lock,
  sourceFilter: string | null
): { groups: SourceGroup[]; incomplete: string[] } {
  const groups = new Map<string, SourceGroup>();
  const incomplete: string[] = [];
  const names = sortNames(activeExternalSkillNames(lock)).filter((name) =>
    inSourceFilter(lock, name, sourceFilter)
  );
  for (const name of names) {
    const located = locateTarget(lock, name);
    if (!located) incomplete.push(name);
    else {
      const { source, sourceUrl, ...target } = located;
      targetGroup(groups, source, sourceUrl).targets.push(target);
    }
  }
  const sorted = sortNames(groups.keys()).flatMap((source) => {
    const group = groups.get(source);
    return group ? [group] : [];
  });
  return { groups: sorted, incomplete };
}

type PlanContext = {
  pins: Record<string, LockPin>;
  globalLock: Record<string, GlobalLockEntry>;
};

function installedTreeOf(
  target: PlanTarget,
  source: string,
  context: PlanContext
): string | null {
  const installed = context.globalLock[target.upstreamName];
  if (!sameSource(installed?.source, source)) return null;
  return installed?.skillFolderHash || null;
}

async function changedFiles(
  clone: UpstreamClone,
  baseTree: string | null,
  headTree: string,
  folder: string
): Promise<UpstreamFileChange[] | null> {
  if (!baseTree || !(await clone.hasTree(baseTree))) return null;
  return clone.diffTrees(baseTree, headTree, folder);
}

async function commitsSincePin(
  clone: UpstreamClone,
  pin: string | null,
  head: string,
  folder: string
): Promise<number | null> {
  if (pin === null || !(await clone.hasCommit(pin))) return null;
  return clone.commitCount(pin, head, folder);
}

function baselineOf(
  installedTree: string | null,
  pinTree: string | null
): UpdateBaseline {
  if (installedTree) return "installed";
  return pinTree ? "pin" : "unknown";
}

async function planSkill(
  clone: UpstreamClone,
  source: string,
  target: PlanTarget,
  head: string,
  context: PlanContext
): Promise<SkillPlanEntry> {
  const { name, upstreamName, skillPath } = target;
  if (target.vendor) return { name, state: "skipped", reason: "vendor" };
  const folder = skillMdFolderPath(skillPath);
  const headTree = await clone.treeOf(head, folder);
  if (!headTree)
    return {
      name,
      state: "failed",
      failure: {
        kind: "missing-path",
        message: `${skillPath} is not in ${source}@${head.slice(0, 12)}`,
      },
    };

  const pin = context.pins[name]?.commit ?? null;
  const pinTree = pin ? await clone.treeOf(pin, folder) : null;
  const installedTree = installedTreeOf(target, source, context);
  const baseTree = installedTree ?? pinTree;
  if (baseTree === headTree) return { name, state: "current" };

  const files = await changedFiles(clone, baseTree, headTree, folder);
  return {
    name,
    state: "update",
    source,
    upstreamName,
    aliased: upstreamName !== name,
    skillPath,
    pin,
    head,
    headTree,
    baseline: baselineOf(installedTree, pinTree),
    commits: await commitsSincePin(clone, pin, head, folder),
    files,
    risky: (files ?? []).filter(isRiskyChange).map((change) => change.path),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function planSource(
  group: SourceGroup,
  workspace: string,
  index: number,
  context: PlanContext
): Promise<{ plan: SourcePlan; clone: UpstreamClone | null }> {
  const pins = sortNames(
    new Set(
      group.targets
        .filter((target) => !target.vendor)
        .flatMap((target) => context.pins[target.name]?.commit ?? [])
    )
  );
  const base = { source: group.source, sourceUrl: group.sourceUrl, pins };
  let clone: UpstreamClone;
  let head: string;
  try {
    clone = await UpstreamClone.clone(
      group.sourceUrl,
      join(workspace, `source-${index}`)
    );
    head = await clone.head();
  } catch (error) {
    const failure: BulkUpdateFailure = {
      kind: "fetch",
      message: errorMessage(error),
    };
    return {
      clone: null,
      plan: {
        ...base,
        head: null,
        skills: group.targets.map((target) =>
          target.vendor
            ? { name: target.name, state: "skipped", reason: "vendor" }
            : { name: target.name, state: "failed", failure }
        ),
      },
    };
  }
  const skills: SkillPlanEntry[] = [];
  for (const target of group.targets)
    skills.push(await planSkill(clone, group.source, target, head, context));
  return { clone, plan: { ...base, head, skills } };
}

async function mapWithWorkers<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Math.min(externalUpdateCheckWorkers(), items.length);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index] as T, index);
      }
    })
  );
  return results;
}

/** 計画の内部状態。適用は計画で作った clone と、退避先の作業ディレクトリを使う。 */
type SessionInternals = {
  workspace: string;
  clones: Map<string, UpstreamClone>;
};

const internals = new WeakMap<ExternalBulkUpdateSession, SessionInternals>();

/**
 * 更新計画を作る。Catalog・Projection・CLI lock のどれも書かない。
 * 対象は `external check` と同じく active な External だけ。
 */
export async function planExternalBulkUpdate(
  lock: Lock,
  sourceFilter: string | null = null
): Promise<ExternalBulkUpdateSession> {
  const { groups, incomplete } = groupBySource(lock, sourceFilter);
  const context: PlanContext = {
    pins: loadLockPins()?.external ?? {},
    globalLock: loadGlobalLock(),
  };
  const workspace = mkdtempSync(join(tmpdir(), "skill-loom-bulk-update-"));
  const planned = await mapWithWorkers(groups, (group, index) =>
    planSource(group, workspace, index, context)
  );
  const sources = planned.map((row) => row.plan);
  if (incomplete.length > 0)
    sources.push({
      source: "(incomplete lock entry)",
      sourceUrl: "",
      head: null,
      pins: [],
      skills: incomplete.map((name) => ({
        name,
        state: "failed",
        failure: {
          kind: "missing-path",
          message: "lock entry has no source or skillPath",
        },
      })),
    });
  const clones = new Map<string, UpstreamClone>();
  for (const row of planned)
    if (row.clone) clones.set(row.plan.source, row.clone);
  const session: ExternalBulkUpdateSession = {
    plan: { sources },
    dispose: () => rmSync(workspace, { recursive: true, force: true }),
  };
  internals.set(session, { workspace, clones });
  return session;
}

type Backup = {
  name: string;
  upstreamName: string;
  dir: string | null;
  cliEntry: GlobalLockEntry | undefined;
};

function backupSkill(update: PlannedSkillUpdate, backupRoot: string): Backup {
  const live = join(activeDir(), update.name);
  const dir = existsSync(live) ? join(backupRoot, update.name) : null;
  if (dir) cpSync(live, dir, { recursive: true, verbatimSymlinks: true });
  return {
    name: update.name,
    upstreamName: update.upstreamName,
    dir,
    cliEntry: loadGlobalLock()[update.upstreamName],
  };
}

/** CLI lock の 1 エントリを退避した値へ戻す。他のエントリと CLI が持つ他のキーは触らない。 */
function restoreCliEntry(key: string, entry: GlobalLockEntry | undefined) {
  const path = globalLockFile();
  if (!existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, "utf-8")) as {
    skills?: Record<string, GlobalLockEntry>;
  };
  const skills = (data.skills ??= {});
  if (entry === undefined) delete skills[key];
  else skills[key] = entry;
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  renameSync(tmp, path);
}

function restoreSkill(backup: Backup): void {
  const live = join(activeDir(), backup.name);
  trashPath(live);
  if (backup.dir)
    cpSync(backup.dir, live, { recursive: true, verbatimSymlinks: true });
  restoreCliEntry(backup.upstreamName, backup.cliEntry);
}

/** 計画した commit の SKILL.md と入った SKILL.md の内容ハッシュが同じか。CLI lock に tree が無いときの確かめ方。 */
function sameSkillMd(
  update: PlannedSkillUpdate,
  clone: UpstreamClone | undefined,
  scratch: string
): boolean {
  const planned = clone?.readBlob(update.head, update.skillPath);
  if (!planned) return false;
  const plannedPath = join(scratch, `${update.name}.planned.md`);
  writeFileSync(plannedPath, planned);
  const installed = join(activeDir(), update.name, "SKILL.md");
  return (
    skillFileHash(plannedPath, update.aliased) ===
    skillFileHash(installed, update.aliased)
  );
}

/** 入った中身が計画した HEAD の tree と同じか。CLI の終了コードだけでは、飛ばされた skill を見分けられない。 */
function verifyInstalled(
  update: PlannedSkillUpdate,
  clone: UpstreamClone | undefined,
  scratch: string
): BulkUpdateFailure | null {
  const skillMd = join(activeDir(), update.name, "SKILL.md");
  if (!existsSync(skillMd))
    return { kind: "verify", message: `${skillMd} is missing after install` };
  const recorded = loadGlobalLock()[update.upstreamName]?.skillFolderHash;
  if (recorded === update.headTree) return null;
  if (recorded)
    return {
      kind: "verify",
      message: `installed tree ${recorded.slice(0, 12)} is not planned ${update.headTree.slice(0, 12)}`,
    };
  if (sameSkillMd(update, clone, scratch)) return null;
  return {
    kind: "verify",
    message: "installed SKILL.md does not match the planned commit",
  };
}

type SourceApply = {
  updated: PlannedSkillUpdate[];
  failed: Array<{ update: PlannedSkillUpdate; failure: BulkUpdateFailure }>;
};

function installSource(
  updates: PlannedSkillUpdate[],
  lock: Lock,
  run: (cmd: string[]) => void
): Map<string, BulkUpdateFailure> {
  const failures = new Map<string, BulkUpdateFailure>();
  const standard = updates.filter((update) => !update.aliased);
  if (standard.length > 0) {
    try {
      for (const cmd of installCommands(
        new Set(standard.map((update) => update.name)),
        lock
      ))
        run(cmd);
    } catch (error) {
      for (const update of standard)
        failures.set(update.name, {
          kind: "install",
          message: errorMessage(error),
        });
    }
  }
  for (const update of updates.filter((row) => row.aliased)) {
    try {
      if (!isAliasedExternal(update.name, lock.external?.[update.name]))
        throw new Error(`not a registered alias: ${update.name}`);
      reinstallAliasedExternal(update.name, lock, run);
    } catch (error) {
      failures.set(update.name, {
        kind: "install",
        message: errorMessage(error),
      });
    }
  }
  return failures;
}

type ApplyContext = {
  run: (cmd: string[]) => void;
  clone: UpstreamClone | undefined;
  backups: Map<string, Backup>;
  backupRoot: string;
};

function backupFor(
  backups: Map<string, Backup>,
  update: PlannedSkillUpdate
): Backup {
  const backup = backups.get(update.name);
  if (!backup) throw new Error(`no backup for ${update.name}`);
  return backup;
}

function applySource(
  updates: PlannedSkillUpdate[],
  lock: Lock,
  context: ApplyContext
): SourceApply {
  for (const update of updates)
    context.backups.set(update.name, backupSkill(update, context.backupRoot));
  const installFailures = installSource(updates, lock, context.run);
  const result: SourceApply = { updated: [], failed: [] };
  for (const update of updates) {
    const failure =
      installFailures.get(update.name) ??
      verifyInstalled(update, context.clone, context.backupRoot);
    if (!failure) {
      result.updated.push(update);
      continue;
    }
    restoreSkill(backupFor(context.backups, update));
    result.failed.push({ update, failure });
  }
  return result;
}

function failedOutcome(
  update: { name: string; source: string },
  failure: BulkUpdateFailure
): BulkUpdateSkillOutcome {
  return {
    name: update.name,
    source: update.source,
    outcome: "failed",
    failure,
  };
}

/**
 * 計画を適用する。適用は直列で、source ごとに `skills add` を 1 回だけ呼ぶ
 * （CLI が `~/.agents/.skill-lock.json` を書くので、並べると互いの書き込みを消す）。
 */
type Triage = {
  ready: PlannedSkillUpdate[];
  settled: BulkUpdateSkillOutcome[];
};

/** 計画の段階で決まる結果（失敗・保留）と、これから入れる skill に分ける。 */
function triageSource(source: SourcePlan, includeRisky: boolean): Triage {
  const triage: Triage = { ready: [], settled: [] };
  for (const entry of source.skills) {
    if (entry.state === "failed")
      triage.settled.push(
        failedOutcome({ ...entry, source: source.source }, entry.failure)
      );
    if (entry.state !== "update") continue;
    if (entry.risky.length > 0 && !includeRisky)
      triage.settled.push({
        name: entry.name,
        source: entry.source,
        outcome: "held",
        reason: "risky",
      });
    else triage.ready.push(entry);
  }
  return triage;
}

function rollbackAll(
  updated: PlannedSkillUpdate[],
  backups: Map<string, Backup>
): BulkUpdateSkillOutcome[] {
  for (const update of updated) restoreSkill(backupFor(backups, update));
  return updated.map((update) =>
    failedOutcome(update, {
      kind: "rolled-back",
      message: "rolled back because another skill failed",
    })
  );
}

/**
 * 計画を適用する。適用は直列で、source ごとに `skills add` を 1 回だけ呼ぶ
 * （CLI が `~/.agents/.skill-lock.json` を書くので、並べると互いの書き込みを消す）。
 */
export function applyExternalBulkUpdate(
  session: ExternalBulkUpdateSession,
  lock: Lock,
  options: BulkUpdateOptions = {}
): BulkUpdateSkillOutcome[] {
  const state = internals.get(session);
  if (!state) throw new Error("plan session was not created by this module");
  const backupRoot = join(state.workspace, "backup");
  mkdirSync(backupRoot, { recursive: true });
  const backups = new Map<string, Backup>();
  const outcomes: BulkUpdateSkillOutcome[] = [];
  const updated: PlannedSkillUpdate[] = [];

  for (const source of session.plan.sources) {
    const { ready, settled } = triageSource(
      source,
      options.includeRisky ?? false
    );
    outcomes.push(...settled);
    if (ready.length === 0) continue;
    const result = applySource(ready, lock, {
      run: options.run ?? runSkillsCli,
      clone: state.clones.get(source.source),
      backups,
      backupRoot,
    });
    updated.push(...result.updated);
    for (const { update, failure } of result.failed)
      outcomes.push(failedOutcome(update, failure));
  }

  const anyFailed = outcomes.some((row) => row.outcome === "failed");
  if (anyFailed && options.onFailure === "rollback-all")
    return [...outcomes, ...rollbackAll(updated, backups)];
  return [...outcomes, ...commitPins(updated, lock, backups)];
}

/** 成功した分のピンを進める。書けなければ中身も戻し、ピンと中身を食い違わせない。 */
function commitPins(
  updated: PlannedSkillUpdate[],
  lock: Lock,
  backups: Map<string, Backup>
): BulkUpdateSkillOutcome[] {
  if (updated.length === 0) return [];
  const resolvedAt = pinTimestamp();
  try {
    advanceExternalPins(
      Object.fromEntries(
        updated.map((update) => [
          update.name,
          pinEntry(
            lock.external?.[update.name]?.sourceUrl,
            update.head,
            resolvedAt
          ),
        ])
      )
    );
  } catch (error) {
    for (const update of updated) restoreSkill(backupFor(backups, update));
    return updated.map((update) =>
      failedOutcome(update, {
        kind: "pins-write",
        message: errorMessage(error),
      })
    );
  }
  return updated.map((update) => ({
    name: update.name,
    source: update.source,
    outcome: "updated",
    commit: update.head,
  }));
}

/**
 * 失敗の種類ごとのビット。複数が重なれば OR する。2（用法の誤り）と 1（中断）は
 * 既存の CLI が使っているので避ける。
 */
const BULK_UPDATE_EXIT_BITS = {
  held: 4,
  fetch: 8,
  "missing-path": 8,
  install: 16,
  verify: 32,
  "rolled-back": 0,
  "pins-write": 64,
} as const;

export function externalBulkUpdateExitCode(
  outcomes: BulkUpdateSkillOutcome[]
): number {
  let code = 0;
  for (const row of outcomes) {
    if (row.outcome === "held") code |= BULK_UPDATE_EXIT_BITS.held;
    if (row.outcome === "failed")
      code |= BULK_UPDATE_EXIT_BITS[row.failure.kind];
  }
  return code;
}

export function planExitCode(plan: ExternalBulkUpdatePlan): number {
  let code = 0;
  for (const source of plan.sources)
    for (const skill of source.skills)
      if (skill.state === "failed")
        code |= BULK_UPDATE_EXIT_BITS[skill.failure.kind];
  return code;
}
