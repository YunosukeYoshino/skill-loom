import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  SkillRef,
  SkillView,
  SkillUpstreamStatus,
} from "../../shared/skill-workspace-types";
import { releaseApply, tryAcquireApply } from "../applyLock";
import { resolveCatalogPath } from "./catalogPaths";
import { activeDir, archiveDir, globalLockFile, lockFile } from "./config";
import { ValueError } from "./errors";
import { loadLock, saveLock } from "./inventory";
import { parseInventoryLock } from "./inventory-lock-schema";
import { checkSkillUpstream } from "../infrastructure/skill-upstream";
import {
  deregisterFromCliLock,
  linkAgentSkillDirs,
  movePath,
  trashPath,
  unlinkAgentSkillDirs,
} from "./projection";
import {
  assertSkillName,
  copySkillTree,
  skillTreeHash,
  writeSkillJson,
} from "./skill-files";
import {
  requireWorkspace,
  type SkillWorkspace,
  SkillWorkspaceConflict,
  skillStatePath,
  sourceFingerprint,
  validateSkillWorkspace,
  viewSkill,
  workspaceRoot,
} from "./skill-workspace";

type Target =
  | "vendor"
  | "upstream"
  | "active"
  | "archive"
  | "original"
  | "baseline";
type Journal = {
  version: 1;
  name: string;
  phase: "prepared" | "committed";
  targets: Array<{ key: Target; existed: boolean }>;
  inventory: string;
  cli: string | null;
  tracking: string | null;
  workspace: string;
  state: "active" | "archive" | "off";
};

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function targetPaths(name: string): Record<Target, string> {
  return {
    vendor: resolveCatalogPath(`vendor/${name}`),
    upstream: resolveCatalogPath(`upstream/${name}`),
    active: join(activeDir(), name),
    archive: join(archiveDir(), name),
    original: join(workspaceRoot(name), "original"),
    baseline: join(workspaceRoot(name), "baseline"),
  };
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function restoreText(path: string, value: string | null): void {
  if (value === null) {
    trashPath(path);
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function rollback(dir: string, journal: Journal): void {
  const paths = targetPaths(journal.name);
  unlinkAgentSkillDirs(journal.name);
  for (const row of journal.targets) {
    const backup = join(dir, row.key);
    if (present(backup)) {
      trashPath(paths[row.key]);
      mkdirSync(join(paths[row.key], ".."), { recursive: true });
      movePath(backup, paths[row.key]);
    } else if (!row.existed) trashPath(paths[row.key]);
  }
  restoreText(lockFile(), journal.inventory);
  restoreText(globalLockFile(), journal.cli);
  restoreText(
    skillStatePath(`tracking/${journal.name}.json`),
    journal.tracking
  );
  restoreText(
    join(workspaceRoot(journal.name), "workspace.json"),
    journal.workspace
  );
  if (journal.state === "active") linkAgentSkillDirs(journal.name);
  trashPath(dir);
}

function validateJournalTargets(journal: Journal, keys: string[]): void {
  if (
    !Array.isArray(journal.targets) ||
    journal.targets.length !== keys.length ||
    new Set(journal.targets.map((row) => row.key)).size !== keys.length ||
    journal.targets.some(
      (row) => !keys.includes(row.key) || typeof row.existed !== "boolean"
    )
  )
    throw new Error("Invalid apply journal");
}

function validateJournalText(journal: Journal): void {
  if (
    typeof journal.inventory !== "string" ||
    typeof journal.workspace !== "string" ||
    (journal.cli !== null && typeof journal.cli !== "string") ||
    (journal.tracking !== null && typeof journal.tracking !== "string")
  )
    throw new Error("Invalid apply journal");
}

function validateWorkspaceBackup(text: string, name: string): void {
  const workspace = JSON.parse(text);
  if (
    workspace?.ref?.name !== name ||
    typeof workspace.fingerprint !== "string" ||
    !Array.isArray(workspace.conflicts) ||
    workspace.conflicts.some((path: unknown) => typeof path !== "string")
  )
    throw new Error("Invalid workspace backup");
}

function validateCliBackup(text: string): void {
  const cli = JSON.parse(text);
  if (
    !cli ||
    typeof cli !== "object" ||
    Array.isArray(cli) ||
    !cli.skills ||
    typeof cli.skills !== "object" ||
    Array.isArray(cli.skills)
  )
    throw new Error("Invalid CLI lock backup");
}

function readApplyJournal(dir: string, name: string): Journal {
  const journal = JSON.parse(
    readFileSync(join(dir, "journal.json"), "utf8")
  ) as Journal;
  if (
    journal.version !== 1 ||
    journal.name !== name ||
    !["prepared", "committed"].includes(journal.phase) ||
    !["active", "archive", "off"].includes(journal.state)
  )
    throw new Error("Invalid apply journal");
  validateJournalTargets(journal, Object.keys(targetPaths(name)));
  validateJournalText(journal);
  parseInventoryLock(JSON.parse(journal.inventory));
  validateWorkspaceBackup(journal.workspace, name);
  if (journal.cli !== null) validateCliBackup(journal.cli);
  if (journal.tracking !== null) {
    const tracking = JSON.parse(journal.tracking);
    if (tracking?.ref?.name !== name)
      throw new Error("Invalid tracking backup");
  }
  return journal;
}

export function recoverSkillApplications(): string[] {
  const root = skillStatePath("transactions");
  if (!existsSync(root)) return [];
  const warnings: string[] = [];
  for (const name of readdirSync(root)) {
    try {
      assertSkillName(name);
      const dir = skillStatePath(`transactions/${name}`);
      const journal = readApplyJournal(dir, name);
      if (journal.phase === "committed") trashPath(dir);
      else rollback(dir, journal);
    } catch (error) {
      warnings.push(
        `復旧が必要: ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return warnings;
}

function reviewedApplication(ref: SkillRef, revision: string) {
  const workspace = requireWorkspace(ref);
  if (workspace.conflicts.length)
    throw new SkillWorkspaceConflict(
      "Resolve all merge conflicts before applying"
    );
  const root = workspaceRoot(ref.name);
  const files = join(root, "files");
  if (revision !== skillTreeHash(files))
    throw new SkillWorkspaceConflict(
      "The working copy has changed; review the new diff before applying"
    );
  if (sourceFingerprint(workspace.ref) !== workspace.fingerprint)
    throw new SkillWorkspaceConflict(
      "The source has changed; compare and reconcile before applying"
    );
  const issues = validateSkillWorkspace(ref.name);
  if (issues.length) throw new ValueError(issues.join("\n"));
  const source = workspace.ref.source;
  if (!source) throw new ValueError("External source is required");
  return { workspace, root, files, source };
}

function validateApplyTargets(
  paths: ReturnType<typeof targetPaths>,
  lock: ReturnType<typeof loadLock>,
  name: string
): void {
  if (present(paths.active) && present(paths.archive))
    throw new SkillWorkspaceConflict("Skill exists in both Active and Archive");
  if (present(paths.vendor) && !lock.vendor?.[name])
    throw new SkillWorkspaceConflict("Vendor path is already occupied");
}

function applicationState(
  paths: ReturnType<typeof targetPaths>,
  managed: boolean
): Journal["state"] {
  if (present(paths.active)) return "active";
  if (present(paths.archive)) return "archive";
  return managed ? "off" : "active";
}

function prepareSkillApplication(ref: SkillRef, revision: string) {
  const reviewed = reviewedApplication(ref, revision);
  const lock = loadLock();
  if (lock.custom?.skills?.[ref.name])
    throw new SkillWorkspaceConflict(
      "Cannot replace an authored skill with a vendor fork"
    );
  const paths = targetPaths(ref.name);
  validateApplyTargets(paths, lock, ref.name);
  const state = applicationState(
    paths,
    Boolean(lock.vendor?.[ref.name] || lock.external?.[ref.name])
  );
  const dir = skillStatePath(`transactions/${ref.name}`);
  if (present(dir))
    throw new SkillWorkspaceConflict("A previous apply requires recovery");
  mkdirSync(dir, { recursive: true });
  const journal: Journal = {
    version: 1,
    name: ref.name,
    phase: "prepared",
    state,
    targets: (Object.keys(paths) as Target[]).map((key) => ({
      key,
      existed: present(paths[key]),
    })),
    inventory: readFileSync(lockFile(), "utf8"),
    cli: readOptional(globalLockFile()),
    tracking: readOptional(skillStatePath(`tracking/${ref.name}.json`)),
    workspace: readFileSync(join(reviewed.root, "workspace.json"), "utf8"),
  };
  writeSkillJson(join(dir, "journal.json"), journal);
  return { ...reviewed, lock, paths, dir, journal };
}

type SkillApplication = ReturnType<typeof prepareSkillApplication>;

function applicationBaseline(application: SkillApplication): string {
  const { root, dir, workspace } = application;
  if (existsSync(join(root, "pending-upstream")) && workspace.pending)
    return join(root, "pending-upstream");
  if (existsSync(join(dir, "baseline"))) return join(dir, "baseline");
  if (existsSync(join(dir, "upstream"))) return join(dir, "upstream");
  return join(dir, "original");
}

function replaceApplicationTrees(application: SkillApplication): void {
  const { workspace, files, paths, dir, journal } = application;
  unlinkAgentSkillDirs(workspace.ref.name);
  for (const row of journal.targets)
    if (row.existed) movePath(paths[row.key], join(dir, row.key));
  copySkillTree(files, paths.vendor);
  const baseline = applicationBaseline(application);
  copySkillTree(baseline, paths.upstream);
  copySkillTree(baseline, paths.baseline);
  copySkillTree(files, paths.original);
}

function registerAppliedVendor(application: SkillApplication): void {
  const { workspace, source, lock, paths, files, journal } = application;
  const { name, skillPath } = workspace.ref;
  (lock.vendor ??= {})[name] = {
    source,
    sourceUrl: `https://github.com/${source}.git`,
    ...(skillPath ? { skillPath } : {}),
  };
  delete lock.external?.[name];
  saveLock(lock);
  const warning = deregisterFromCliLock(new Set([name]));
  if (warning) throw new Error(warning);
  if (journal.state !== "off") {
    mkdirSync(join(paths[journal.state], ".."), { recursive: true });
    copySkillTree(files, paths[journal.state]);
    if (journal.state === "active") linkAgentSkillDirs(name);
  }
}

async function appliedUpstreamStatus(
  workspace: SkillWorkspace,
  previous: SkillUpstreamStatus | undefined
): Promise<SkillUpstreamStatus> {
  const baseline = workspace.pending ?? workspace.baseline;
  const compared = await checkSkillUpstream(workspace.ref, baseline, false);
  if (["missing", "unavailable", "review"].includes(previous?.state ?? ""))
    return { ...previous!, baseline, behind: null };
  return {
    ...compared,
    checkedAt: previous?.checkedAt,
    attemptedAt: previous?.attemptedAt,
  };
}

async function commitSkillApplication(
  application: SkillApplication
): Promise<void> {
  const { workspace, root, dir, journal } = application;
  replaceApplicationTrees(application);
  registerAppliedVendor(application);
  const baselineVersion = workspace.pending ?? workspace.baseline;
  const tracking: { status?: SkillUpstreamStatus } = journal.tracking
    ? JSON.parse(journal.tracking)
    : {};
  let status = tracking.status;
  if (workspace.pending)
    status = await appliedUpstreamStatus(workspace, tracking.status);
  writeSkillJson(skillStatePath(`tracking/${workspace.ref.name}.json`), {
    ...tracking,
    ref: workspace.ref,
    baseline: baselineVersion,
    ...(status ? { status } : {}),
  });
  delete workspace.pending;
  workspace.baseline = baselineVersion;
  workspace.conflicts = [];
  workspace.fingerprint = sourceFingerprint(workspace.ref);
  writeSkillJson(join(root, "workspace.json"), workspace);
  journal.phase = "committed";
  writeSkillJson(join(dir, "journal.json"), journal);
}

/** 正本・Inventory・Projection・基準版を同じ journal で復旧する。Deck は名前を維持する。 */
export async function applySkillWorkspace(
  ref: SkillRef,
  revision: string
): Promise<SkillView> {
  if (!tryAcquireApply())
    throw new SkillWorkspaceConflict("Another apply is running");
  try {
    const application = prepareSkillApplication(ref, revision);
    try {
      await commitSkillApplication(application);
    } catch (error) {
      try {
        rollback(application.dir, application.journal);
      } catch (recovery) {
        throw new Error(
          `適用に失敗し復旧が必要です: ${String(error)} / ${String(recovery)}`
        );
      }
      throw error;
    }
    let message = "Fork を適用しました";
    try {
      trashPath(application.dir);
    } catch {
      message += "（退避データの回収は次回起動時に再試行します）";
    }
    return {
      ...(await viewSkill(application.workspace.ref, "source")),
      message,
    };
  } finally {
    releaseApply();
  }
}
