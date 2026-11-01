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
import type { SkillRef, SkillView } from "../../shared/skill-workspace-types";
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

export function recoverSkillApplications(): string[] {
  const root = skillStatePath("transactions");
  if (!existsSync(root)) return [];
  const warnings: string[] = [];
  for (const name of readdirSync(root)) {
    try {
      assertSkillName(name);
      const dir = skillStatePath(`transactions/${name}`);
      const journal = JSON.parse(
        readFileSync(join(dir, "journal.json"), "utf8")
      ) as Journal;
      const keys = Object.keys(targetPaths(name));
      if (
        journal.version !== 1 ||
        journal.name !== name ||
        !["prepared", "committed"].includes(journal.phase) ||
        !Array.isArray(journal.targets) ||
        journal.targets.some((row) => !keys.includes(row.key)) ||
        journal.targets.length !== keys.length ||
        new Set(journal.targets.map((row) => row.key)).size !== keys.length ||
        typeof journal.inventory !== "string" ||
        typeof journal.workspace !== "string" ||
        (journal.cli !== null && typeof journal.cli !== "string") ||
        (journal.tracking !== null && typeof journal.tracking !== "string") ||
        journal.targets.some((row) => typeof row.existed !== "boolean") ||
        !["active", "archive", "off"].includes(journal.state)
      )
        throw new Error("Invalid apply journal");
      parseInventoryLock(JSON.parse(journal.inventory));
      const workspace = JSON.parse(journal.workspace);
      if (
        workspace?.ref?.name !== name ||
        typeof workspace.fingerprint !== "string" ||
        !Array.isArray(workspace.conflicts) ||
        workspace.conflicts.some((path: unknown) => typeof path !== "string")
      )
        throw new Error("Invalid workspace backup");
      if (journal.cli !== null) {
        const cli = JSON.parse(journal.cli);
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
      if (journal.tracking !== null) {
        const tracking = JSON.parse(journal.tracking);
        if (tracking?.ref?.name !== name)
          throw new Error("Invalid tracking backup");
      }
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

/** 正本・Inventory・Projection・基準版を同じ journal で復旧する。Deck は名前を維持する。 */
export async function applySkillWorkspace(
  ref: SkillRef,
  revision: string
): Promise<SkillView> {
  if (!tryAcquireApply())
    throw new SkillWorkspaceConflict("Another apply is running");
  try {
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
    if (!workspace.ref.source)
      throw new ValueError("External source is required");
    const lock = loadLock();
    if (lock.custom?.skills?.[ref.name])
      throw new SkillWorkspaceConflict(
        "Cannot replace an authored skill with a vendor fork"
      );
    const paths = targetPaths(ref.name);
    if (present(paths.active) && present(paths.archive))
      throw new SkillWorkspaceConflict(
        "Skill exists in both Active and Archive"
      );
    if (present(paths.vendor) && !lock.vendor?.[ref.name])
      throw new SkillWorkspaceConflict("Vendor path is already occupied");
    const managed = Boolean(
      lock.vendor?.[ref.name] || lock.external?.[ref.name]
    );
    const state = present(paths.active)
      ? "active"
      : present(paths.archive)
        ? "archive"
        : managed
          ? "off"
          : "active";
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
      workspace: readFileSync(join(root, "workspace.json"), "utf8"),
    };
    writeSkillJson(join(dir, "journal.json"), journal);
    try {
      unlinkAgentSkillDirs(ref.name);
      for (const row of journal.targets)
        if (row.existed) movePath(paths[row.key], join(dir, row.key));
      copySkillTree(files, paths.vendor);
      const baseline =
        existsSync(join(root, "pending-upstream")) && workspace.pending
          ? join(root, "pending-upstream")
          : existsSync(join(dir, "baseline"))
            ? join(dir, "baseline")
            : existsSync(join(dir, "upstream"))
              ? join(dir, "upstream")
              : join(dir, "original");
      copySkillTree(baseline, paths.upstream);
      copySkillTree(baseline, paths.baseline);
      copySkillTree(files, paths.original);
      (lock.vendor ??= {})[ref.name] = {
        source: workspace.ref.source,
        sourceUrl: `https://github.com/${workspace.ref.source}.git`,
        ...(workspace.ref.skillPath
          ? { skillPath: workspace.ref.skillPath }
          : {}),
      };
      delete lock.external?.[ref.name];
      saveLock(lock);
      const warning = deregisterFromCliLock(new Set([ref.name]));
      if (warning) throw new Error(warning);
      if (state !== "off") {
        mkdirSync(join(paths[state], ".."), { recursive: true });
        copySkillTree(files, paths[state]);
        if (state === "active") linkAgentSkillDirs(ref.name);
      }
      const baselineVersion = workspace.pending ?? workspace.baseline;
      const tracking = journal.tracking ? JSON.parse(journal.tracking) : {};
      let status = tracking.status;
      if (workspace.pending) {
        const compared = await checkSkillUpstream(
          workspace.ref,
          baselineVersion,
          false
        );
        status = {
          ...compared,
          checkedAt: tracking.status?.checkedAt,
          attemptedAt: tracking.status?.attemptedAt,
        };
        if (
          ["missing", "unavailable", "review"].includes(tracking.status?.state)
        )
          status = {
            ...tracking.status,
            baseline: baselineVersion,
            behind: null,
          };
      }
      writeSkillJson(skillStatePath(`tracking/${ref.name}.json`), {
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
    } catch (error) {
      try {
        rollback(dir, journal);
      } catch (recovery) {
        throw new Error(
          `適用に失敗し復旧が必要です: ${String(error)} / ${String(recovery)}`
        );
      }
      throw error;
    }
    let message = "Fork を適用しました";
    try {
      trashPath(dir);
    } catch {
      message += "（退避データの回収は次回起動時に再試行します）";
    }
    return { ...(await viewSkill(workspace.ref, "source")), message };
  } finally {
    releaseApply();
  }
}
