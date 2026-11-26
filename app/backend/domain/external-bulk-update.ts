/**
 * External Skill の一括更新。計画（読むだけ）と適用（書く）を分ける。
 *
 * 計画は source ごとに上流 repo を 1 回だけ blob なしで clone し、入っている tree
 * （CLI lock の skillFolderHash、無ければピンの commit）と HEAD の tree を比べる。
 * 適用は source ごとに `skills add` を 1 回まとめて呼び、別名で入れた skill だけ
 * 上流名で入れ直す。CLI lock に記録された tree が計画した HEAD と一致した skill だけ
 * ピンを進め、それ以外は退避しておいた中身と CLI lock のエントリへ戻す。
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
import { basename, join } from "node:path";
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

export type HoldReason = "risky" | "unknown-diff";

/** 確かめずに入れてはいけない更新の理由。差分が読めないものは中身を確かめられないので risky と同じく止める。 */
export function holdReason(update: PlannedSkillUpdate): HoldReason | null {
  if (update.files === null) return "unknown-diff";
  return update.risky.length > 0 ? "risky" : null;
}

export type BulkUpdateSkillOutcome =
  | { name: string; source: string; outcome: "updated"; commit: string }
  | { name: string; source: string; outcome: "held"; reason: HoldReason }
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

type Installed = { skillPath: string; tree: string | null };

function installedOf(
  target: PlanTarget,
  source: string,
  context: PlanContext
): Installed {
  const entry = context.globalLock[target.upstreamName];
  if (!entry || !sameSource(entry.source, source))
    return { skillPath: target.skillPath, tree: null };
  return {
    skillPath: entry.skillPath || target.skillPath,
    tree: entry.skillFolderHash || null,
  };
}

function missingPath(
  name: string,
  skillPath: string,
  source: string,
  head: string
): SkillPlanEntry {
  return {
    name,
    state: "failed",
    failure: {
      kind: "missing-path",
      message: `${skillPath} is not in ${source}@${head.slice(0, 12)}`,
    },
  };
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

async function skillTreeAt(
  clone: UpstreamClone,
  commit: string,
  skillPath: string
): Promise<string | null> {
  const tree = await clone.treeOf(commit, skillMdFolderPath(skillPath));
  if (!tree || !(await clone.treeHasBlob(tree, basename(skillPath))))
    return null;
  return tree;
}

type LocatedSkill = {
  skillPath: string;
  headTree: string;
  installedTree: string | null;
  pinTree: string | null;
};

async function locateSkill(
  clone: UpstreamClone,
  head: string,
  installed: Installed,
  catalogPath: string,
  pin: string | null
): Promise<LocatedSkill | null> {
  const headTree = await skillTreeAt(clone, head, installed.skillPath);
  if (headTree) {
    const folder = skillMdFolderPath(installed.skillPath);
    return {
      skillPath: installed.skillPath,
      headTree,
      installedTree: installed.tree,
      pinTree: pin ? await clone.treeOf(pin, folder) : null,
    };
  }
  if (catalogPath === installed.skillPath) return null;
  const movedTree = await skillTreeAt(clone, head, catalogPath);
  if (!movedTree) return null;
  return {
    skillPath: catalogPath,
    headTree: movedTree,
    installedTree: null,
    pinTree: null,
  };
}

async function planSkill(
  clone: UpstreamClone,
  source: string,
  target: PlanTarget,
  head: string,
  context: PlanContext
): Promise<SkillPlanEntry> {
  const { name, upstreamName } = target;
  if (target.vendor) return { name, state: "skipped", reason: "vendor" };
  const installed = installedOf(target, source, context);
  const pin = context.pins[name]?.commit ?? null;
  const located = await locateSkill(
    clone,
    head,
    installed,
    target.skillPath,
    pin
  );
  if (!located) return missingPath(name, installed.skillPath, source, head);
  const { skillPath, headTree, installedTree, pinTree } = located;
  const baseTree = installedTree ?? pinTree;
  if (baseTree === headTree) return { name, state: "current" };

  const folder = skillMdFolderPath(skillPath);
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

async function planSkillOrFail(
  clone: UpstreamClone,
  source: string,
  target: PlanTarget,
  head: string,
  context: PlanContext
): Promise<SkillPlanEntry> {
  try {
    return await planSkill(clone, source, target, head, context);
  } catch (error) {
    return {
      name: target.name,
      state: "failed",
      failure: { kind: "fetch", message: errorMessage(error) },
    };
  }
}

async function planSource(
  group: SourceGroup,
  workspace: string,
  index: number,
  context: PlanContext
): Promise<SourcePlan> {
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
      ...base,
      head: null,
      skills: group.targets.map((target) =>
        target.vendor
          ? { name: target.name, state: "skipped", reason: "vendor" }
          : { name: target.name, state: "failed", failure }
      ),
    };
  }
  const skills: SkillPlanEntry[] = [];
  for (const target of group.targets)
    skills.push(
      await planSkillOrFail(clone, group.source, target, head, context)
    );
  return { ...base, head, skills };
}

async function mapWithWorkers<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Math.min(externalUpdateCheckWorkers(), items.length);
  const settled = await Promise.allSettled(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index] as T, index);
      }
    })
  );
  const rejected = settled.find((lane) => lane.status === "rejected");
  if (rejected) throw rejected.reason;
  return results;
}

type SessionInternals = {
  workspace: string;
  pinsTracked: boolean;
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
  const lockPins = loadLockPins();
  const context: PlanContext = {
    pins: lockPins?.external ?? {},
    globalLock: loadGlobalLock(),
  };
  const workspace = mkdtempSync(join(tmpdir(), "skill-loom-bulk-update-"));
  const dispose = () => rmSync(workspace, { recursive: true, force: true });
  let sources: SourcePlan[];
  try {
    sources = await mapWithWorkers(groups, (group, index) =>
      planSource(group, workspace, index, context)
    );
  } catch (error) {
    dispose();
    throw error;
  }
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
  const session: ExternalBulkUpdateSession = { plan: { sources }, dispose };
  internals.set(session, { workspace, pinsTracked: lockPins !== null });
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

function moveOutOfWorkspace(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
}

function keepBackup(backup: Backup): string {
  if (!backup.dir) return "no backup (the skill was not installed before)";
  try {
    const kept = join(
      mkdtempSync(join(tmpdir(), "skill-loom-bulk-update-kept-")),
      backup.name
    );
    moveOutOfWorkspace(backup.dir, kept);
    return `backup kept at ${kept}`;
  } catch (error) {
    return `could not keep the backup: ${errorMessage(error)}`;
  }
}

function restoreInto(
  backup: Backup,
  failure: BulkUpdateFailure
): BulkUpdateFailure {
  try {
    restoreSkill(backup);
    return failure;
  } catch (error) {
    return {
      kind: failure.kind,
      message: `${failure.message}; restore failed: ${errorMessage(error)}; ${keepBackup(backup)}`,
    };
  }
}

/** 入った中身が計画した HEAD の tree と同じか。CLI の終了コードだけでは、飛ばされた skill を見分けられない。 */
function verifyInstalled(update: PlannedSkillUpdate): BulkUpdateFailure | null {
  const skillMd = join(activeDir(), update.name, "SKILL.md");
  if (!existsSync(skillMd))
    return { kind: "verify", message: `${skillMd} is missing after install` };
  const recorded = loadGlobalLock()[update.upstreamName]?.skillFolderHash;
  if (recorded === update.headTree) return null;
  if (!recorded)
    return {
      kind: "verify",
      message:
        "the skills CLI recorded no folder hash, so the install cannot be checked",
    };
  return {
    kind: "verify",
    message: `installed tree ${recorded.slice(0, 12)} is not planned ${update.headTree.slice(0, 12)}`,
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

function backUpEach(
  updates: PlannedSkillUpdate[],
  context: ApplyContext,
  result: SourceApply
): PlannedSkillUpdate[] {
  const backedUp: PlannedSkillUpdate[] = [];
  for (const update of updates) {
    try {
      context.backups.set(update.name, backupSkill(update, context.backupRoot));
      backedUp.push(update);
    } catch (error) {
      result.failed.push({
        update,
        failure: {
          kind: "install",
          message: `not installed because the backup failed: ${errorMessage(error)}`,
        },
      });
    }
  }
  return backedUp;
}

function applySource(
  updates: PlannedSkillUpdate[],
  lock: Lock,
  context: ApplyContext
): SourceApply {
  const result: SourceApply = { updated: [], failed: [] };
  const backedUp = backUpEach(updates, context, result);
  const installFailures = installSource(backedUp, lock, context.run);
  for (const update of backedUp) {
    const failure = installFailures.get(update.name) ?? verifyInstalled(update);
    if (!failure) {
      result.updated.push(update);
      continue;
    }
    result.failed.push({
      update,
      failure: restoreInto(backupFor(context.backups, update), failure),
    });
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

type Triage = {
  ready: PlannedSkillUpdate[];
  settled: BulkUpdateSkillOutcome[];
};

function triageSource(source: SourcePlan, includeRisky: boolean): Triage {
  const triage: Triage = { ready: [], settled: [] };
  for (const entry of source.skills) {
    if (entry.state === "failed")
      triage.settled.push(
        failedOutcome({ ...entry, source: source.source }, entry.failure)
      );
    if (entry.state !== "update") continue;
    const reason = includeRisky ? null : holdReason(entry);
    if (reason)
      triage.settled.push({
        name: entry.name,
        source: entry.source,
        outcome: "held",
        reason,
      });
    else triage.ready.push(entry);
  }
  return triage;
}

function restoreAll(
  updated: PlannedSkillUpdate[],
  backups: Map<string, Backup>,
  failure: BulkUpdateFailure
): BulkUpdateSkillOutcome[] {
  return updated.map((update) =>
    failedOutcome(update, restoreInto(backupFor(backups, update), failure))
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
      backups,
      backupRoot,
    });
    updated.push(...result.updated);
    for (const { update, failure } of result.failed)
      outcomes.push(failedOutcome(update, failure));
  }

  const anyFailed = outcomes.some((row) => row.outcome === "failed");
  if (anyFailed && options.onFailure === "rollback-all")
    return [
      ...outcomes,
      ...restoreAll(updated, backups, {
        kind: "rolled-back",
        message: "rolled back because another skill failed",
      }),
    ];
  return [
    ...outcomes,
    ...commitPins(updated, lock, backups, state.pinsTracked),
  ];
}

function commitPins(
  updated: PlannedSkillUpdate[],
  lock: Lock,
  backups: Map<string, Backup>,
  pinsTracked: boolean
): BulkUpdateSkillOutcome[] {
  if (updated.length === 0) return [];
  const resolvedAt = pinTimestamp();
  try {
    const written = advanceExternalPins(
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
    if (pinsTracked && !written)
      throw new Error("the lock pins file disappeared after planning");
  } catch (error) {
    return restoreAll(updated, backups, {
      kind: "pins-write",
      message: errorMessage(error),
    });
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
